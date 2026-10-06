// The desk: framework-agnostic operations behind the LLM tools, the MCP server and the HTTP API. Stateless:
// every call loads fresh market data, and a signed plan travels with the client and is re-verified on use.
import {
  atr,
  BitgetDataMcp,
  BitgetRest,
  buildTickets,
  type Candle,
  type LoadedSnapshot,
  loadMarketSnapshot,
  type Optional,
  rsi,
  SignalMcp,
  SourceCache,
  venueCheck,
} from "@slipway/bitget";
import {
  assertTicketable,
  atlasKey,
  buildPlan as corePlan,
  depthWithin,
  type GateResult,
  type MarketSnapshot,
  mid,
  type OrderIntent,
  type PlannerOptions,
  type PlanResult,
  type Profile,
  planExecution,
  runGate,
  type Session,
  type SignedPlan,
  type SourceRef,
  type StrategyKind,
  type StrategyQuote,
  sessionAt,
  signPlan,
  spreadBps,
  transitions,
  type Venue,
  venueTradable,
} from "@slipway/core";
import type {
  AtlasStatus,
  BookView,
  ExplainData,
  GatePreview,
  MarketData,
  OptionsData,
  PlanData,
  ResearchData,
  ResolvedIntent,
  TicketsData,
  TideData,
  TrackData,
} from "@slipway/sdk";
import { parseDeadline } from "./deadline.js";
import { explainEntry, TICKET_MAX_AGE_MS, TOPICS } from "./explain.js";
import { type DeskKeys, envKeys } from "./keys.js";
import { type AtlasDoc, DerivedArtifacts, withAtlas } from "./remote.js";
import {
  DEFAULT_PROFILE,
  type IntentInput,
  IntentSchema,
  normalizeSymbol,
  ProfileSchema,
  SymbolSchema,
} from "./schemas.js";
import { type DeskResult, nyText, SlotBag } from "./slots.js";
import { type CheckView, GATE, gateSlots, PLANNER, quoteSlots, quoteView, sliceViews } from "./views.js";

export class DeskError extends Error {
  constructor(
    message: string,
    readonly code: "BAD_INPUT" | "NO_MARKET" | "NOT_FOUND" | "UNAVAILABLE",
    readonly sources: SourceRef[] = [],
  ) {
    super(message);
    this.name = "DeskError";
  }
}

export interface DeskOptions {
  clock?: () => number;
  /** Market snapshot without the atlas (the desk applies the atlas itself). */
  snapshot?: (symbol: string) => Promise<LoadedSnapshot>;
  artifacts?: Pick<DerivedArtifacts, "atlas" | "trackRecord">;
  keys?: () => Promise<DeskKeys>;
  dataMcp?: BitgetDataMcp | null;
  signal?: SignalMcp | null;
  rest?: BitgetRest;
  planner?: Partial<PlannerOptions>;
  /** Budget for each optional research source before it is reported unavailable. */
  researchBudgetMs?: number;
}

const VENUES: Venue[] = ["rtoken", "perp"];
const FAMILIES: StrategyKind[] = ["immediate", "sliced", "passive", "wait", "perp_then_rotate", "perp_hold"];
const BOOK_SOURCE: Record<Venue, string> = { rtoken: "bitget.spot.orderbook", perp: "bitget.mix.orderbook" };
const FEE_SOURCE: Record<Venue, string> = { rtoken: "bitget.spot.symbol", perp: "bitget.mix.contract" };

export const planIdOf = (s: Pick<SignedPlan, "hash">): string => s.hash.slice(0, 12);

const usdOf = (bps: number, notional: number) => (bps / 1e4) * notional;
const checkViews = (g: GateResult): CheckView[] =>
  g.checks.map((c) =>
    c.fix
      ? { code: c.code, status: c.status, detail: c.detail, fix: c.fix }
      : { code: c.code, status: c.status, detail: c.detail },
  );

function budgeted<T>(p: Promise<Optional<T>>, ms: number, id: string, now: number): Promise<Optional<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Optional<T>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          data: null,
          source: { id, status: "unavailable", asOf: null, since: now, detail: `no answer within ${ms} ms` },
          latencyMs: ms,
        }),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export class Desk {
  readonly clock: () => number;
  private readonly snapshotOf: (symbol: string) => Promise<LoadedSnapshot>;
  private readonly artifacts: Pick<DerivedArtifacts, "atlas" | "trackRecord">;
  private readonly keysOf: () => Promise<DeskKeys>;
  private readonly opts: DeskOptions;

  constructor(opts: DeskOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? Date.now;
    this.snapshotOf = opts.snapshot ?? ((s) => loadMarketSnapshot(s));
    this.artifacts = opts.artifacts ?? new DerivedArtifacts();
    this.keysOf = opts.keys ?? (() => envKeys());
  }

  async publicKey(): Promise<{ publicKey: string; alg: "Ed25519"; origin: DeskKeys["origin"] }> {
    const k = await this.keysOf();
    return { publicKey: k.publicKey, alg: "Ed25519", origin: k.origin };
  }

  private async market(rawSymbol: string): Promise<{ snap: LoadedSnapshot; atlas: Optional<AtlasDoc> }> {
    const parsed = SymbolSchema.safeParse(rawSymbol);
    if (!parsed.success) throw new DeskError(`"${rawSymbol}" is not a ticker`, "BAD_INPUT");
    const symbol = normalizeSymbol(parsed.data);
    const [atlas, snap] = await Promise.all([
      this.artifacts.atlas(),
      this.snapshotOf(symbol).catch((e: unknown) => {
        const sources = (e as { sources?: SourceRef[] }).sources ?? [];
        throw new DeskError(e instanceof Error ? e.message : String(e), "NO_MARKET", sources);
      }),
    ]);
    return { snap: withAtlas(snap, atlas), atlas };
  }

  private atlasStatus(atlas: Optional<AtlasDoc>, snap: MarketSnapshot): AtlasStatus {
    const s: AtlasStatus = {
      status: atlas.source.status,
      asOf: atlas.source.asOf,
      keys: Object.keys(snap.atlas).length,
    };
    if (atlas.source.detail) s.detail = atlas.source.detail;
    return s;
  }

  private resolveIntent(
    input: IntentInput,
    profile: Profile,
    snap: MarketSnapshot,
  ): { intent: OrderIntent; resolved: ResolvedIntent; profile: Profile } {
    const parsed = IntentSchema.safeParse(input);
    if (!parsed.success)
      throw new DeskError(
        `invalid order: ${parsed.error.issues.map((i) => `${i.path.join(".") || "order"}: ${i.message}`).join("; ")}`,
        "BAD_INPUT",
      );
    const i = parsed.data;
    const intent: OrderIntent = { symbol: snap.symbol, side: i.side };
    const resolved: ResolvedIntent = {
      symbol: snap.symbol,
      side: i.side,
      urgency: i.urgency ?? profile.urgency,
    };
    if (i.notionalUsd !== undefined) intent.notionalUsd = resolved.notionalUsd = i.notionalUsd;
    if (i.qty !== undefined) intent.qty = resolved.qty = i.qty;
    if (i.holdHorizonHours !== undefined)
      intent.holdHorizonHours = resolved.holdHorizonHours = i.holdHorizonHours;
    if (i.venues) intent.venues = resolved.venues = [...new Set(i.venues)];
    if (i.deadline) {
      const d = parseDeadline(i.deadline, snap.now, snap.holidays);
      if (!d.ok) throw new DeskError(d.error, "BAD_INPUT");
      intent.deadline = resolved.deadline = d.ts;
      resolved.deadlineNy = nyText(d.ts);
      resolved.deadlineReading = d.reading;
    }
    return { intent, resolved, profile: { ...profile, urgency: resolved.urgency } };
  }

  private plan(intent: OrderIntent, profile: Profile, snap: MarketSnapshot): PlanResult {
    try {
      return planExecution(intent, profile, snap, this.opts.planner);
    } catch (e) {
      throw new DeskError(e instanceof Error ? e.message : String(e), "NO_MARKET", snap.sources);
    }
  }

  private gate(result: PlanResult, strategyId: string, profile: Profile, snap: MarketSnapshot) {
    const plan = corePlan(result, strategyId);
    return {
      plan,
      gate: runGate({ plan, snapshot: snap, profile, now: this.clock(), candidates: result.candidates }),
    };
  }

  // ---------------------------------------------------------------------------------------------------------

  async marketState(symbol: string): Promise<DeskResult<MarketData>> {
    const { snap, atlas } = await this.market(symbol);
    const now = snap.now;
    const session = sessionAt(now, snap.holidays);
    const bag = new SlotBag();
    bag
      .text("symbol", snap.symbol, "user")
      .time("now", now, "slipway.clock")
      .text("session", session.session, "bitget.reality.session");
    const venues: MarketData["venues"] = { rtoken: null, perp: null };
    for (const v of VENUES) {
      const b = snap.books[v];
      const tradable = venueTradable(v, session.session, snap.sessions);
      const s = bag.scope(v);
      s.text("tradableNow", tradable ? "open" : "closed", "bitget.reality.session");
      const fees = snap.fees[v];
      s.bps("takerFee", fees.taker * 1e4, FEE_SOURCE[v], 1).bps(
        "makerFee",
        fees.maker * 1e4,
        FEE_SOURCE[v],
        1,
        true,
      );
      if (!b?.bids[0] || !b.asks[0]) {
        venues[v] = { tradableNow: tradable, book: null, fees };
        s.text("book", "unavailable", BOOK_SOURCE[v]);
        continue;
      }
      const depth = (bps: number) => ({
        bid: depthWithin(b, "sell", bps).notional,
        ask: depthWithin(b, "buy", bps).notional,
      });
      const view: BookView = {
        mid: mid(b),
        bid: b.bids[0].px,
        ask: b.asks[0].px,
        spreadBps: spreadBps(b),
        depthUsd: { b10: depth(10), b25: depth(25), b50: depth(50) },
        ageMs: now - b.ts,
        levels: { bids: b.bids.length, asks: b.asks.length },
      };
      venues[v] = { tradableNow: tradable, book: view, fees };
      s.price("mid", view.mid, BOOK_SOURCE[v])
        .price("bid", view.bid, BOOK_SOURCE[v])
        .price("ask", view.ask, BOOK_SOURCE[v])
        .bps("spread", view.spreadBps, BOOK_SOURCE[v], 2)
        .seconds("bookAge", Math.round(view.ageMs / 1000), BOOK_SOURCE[v]);
      s.text("depth.b25.band", "±25 bp of mid", BOOK_SOURCE[v]);
      for (const k of ["b10", "b25", "b50"] as const) {
        s.usd(`depth.${k}.bid`, view.depthUsd[k].bid, BOOK_SOURCE[v]).usd(
          `depth.${k}.ask`,
          view.depthUsd[k].ask,
          BOOK_SOURCE[v],
        );
      }
    }
    const r = venues.rtoken?.book;
    const p = venues.perp?.book;
    const basisBps = r && p ? (r.mid / p.mid - 1) * 1e4 : null;
    bag.bps("basis", basisBps, "bitget.spot.orderbook", 1, true);
    if (snap.funding) {
      bag
        .pct("funding.rate", snap.funding.rate, "bitget.mix.funding", 4, true)
        .put("funding.intervalHours", snap.funding.intervalHours, "count", "bitget.mix.funding")
        .time("funding.next", snap.funding.nextFundingTime, "bitget.mix.funding");
    }
    const next = transitions(now, now + 4 * 86_400_000, snap.holidays).slice(0, 6);
    next.forEach((t, i) => {
      bag
        .scope(`next${i}`)
        .text("session", t.session, "bitget.reality.session")
        .time("start", t.start, "bitget.reality.session")
        .time("end", t.end, "bitget.reality.session");
    });
    const events = snap.events.map((e) => ({
      kind: e.kind,
      label: e.label,
      ts: e.ts,
      ny: nyText(e.ts),
      windowSec: e.windowSec,
      source: e.source,
    }));
    events.forEach((e, i) => {
      bag.scope(`event${i}`).text("label", e.label, e.source).time("at", e.ts, e.source);
    });
    bag.count("events", events.length, "slipway.desk");
    snap.integrity.forEach((f, i) => {
      bag.scope(`flag${i}`).text("code", f.code, f.source).text("detail", f.detail, f.source);
    });
    const atlasStatus = this.atlasStatus(atlas, snap);
    bag.text("atlas", atlasStatus.status, atlas.source.id);
    return {
      data: {
        symbol: snap.symbol,
        now,
        nowNy: nyText(now),
        session,
        venues,
        basisBps,
        funding: snap.funding,
        nextSessions: next.map((t) => ({ ...t, startNy: nyText(t.start), endNy: nyText(t.end) })),
        events,
        integrity: snap.integrity,
        indexComponents: snap.indexComponents ?? null,
        atlas: atlasStatus,
      },
      slots: bag.slots,
      sources: snap.sources,
    };
  }

  async priceOptions(
    input: IntentInput,
    profileInput: Profile = DEFAULT_PROFILE,
  ): Promise<DeskResult<OptionsData>> {
    const base = ProfileSchema.parse(profileInput);
    const { snap, atlas } = await this.market(input.symbol);
    const { intent, resolved, profile } = this.resolveIntent(input, base, snap);
    const result = this.plan(intent, profile, snap);
    const bag = new SlotBag();
    const best = result.best ? quoteView(result.best) : null;
    const baseline = result.baseline ? quoteView(result.baseline) : null;
    const families: OptionsData["families"] = {};
    for (const f of FAMILIES) {
      const q = result.bestByFamily[f];
      if (q) families[f] = quoteView(q);
    }
    let gate: GatePreview | null = null;
    if (result.best) {
      const g = this.gate(result, result.best.id, profile, snap).gate;
      gate = { strategyId: result.best.id, verdict: g.verdict, checks: checkViews(g) };
      gateSlots(bag.scope("gate"), g);
    }
    const saving =
      best && baseline
        ? {
            bps: baseline.expectedBps - best.expectedBps,
            usd: usdOf(baseline.expectedBps - best.expectedBps, result.notionalUsd),
          }
        : null;

    this.orderSlots(bag.scope("order"), resolved, result);
    if (best) quoteSlots(bag.scope("best"), best);
    if (baseline) quoteSlots(bag.scope("baseline"), baseline);
    for (const [f, q] of Object.entries(families)) quoteSlots(bag.scope(f), q);
    if (saving) bag.bps("saving.bps", saving.bps, PLANNER, 1, true).usd("saving.usd", saving.usd, PLANNER);
    bag
      .count("candidates", result.candidates.length, PLANNER)
      .count("feasible", result.candidates.filter((c) => c.feasible !== false).length, PLANNER);
    bag.count("skipped", result.skipped.length, PLANNER);
    bag.put("lambda", result.lambda, "price", PLANNER, { dp: 2 });
    bag.text("urgency", profile.urgency, "user").bps("costCap", profile.costCapBps, "user", 1);
    bag.bps("basis", result.basisBps, "bitget.spot.orderbook", 1, true);
    const atlasStatus = this.atlasStatus(atlas, snap);
    bag.text("atlas", atlasStatus.status, atlas.source.id);
    result.assumptions.forEach((a, i) => {
      bag.text(`assumption${i}`, a, PLANNER);
    });

    const reasons = new Map<string, number>();
    for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    const skippedReasons = [...reasons]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }));
    skippedReasons.slice(0, 5).forEach((r, i) => {
      bag.text(`skipReason${i}`, r.reason, PLANNER).count(`skipCount${i}`, r.count, PLANNER);
    });

    return {
      data: {
        intent: resolved,
        profile,
        now: snap.now,
        nowNy: nyText(snap.now),
        qty: result.qty,
        notionalUsd: result.notionalUsd,
        arrivalMids: result.arrivalMids,
        basisBps: result.basisBps,
        lambda: result.lambda,
        best,
        baseline,
        families,
        savingVsBaseline: saving,
        frontier: result.candidates.map((c) => ({
          id: c.id,
          kind: c.kind,
          expectedBps: c.expectedBps,
          sdBps: c.sdBps,
          score: c.score,
          feasible: c.feasible !== false,
        })),
        candidates: result.candidates.length,
        skipped: { count: result.skipped.length, reasons: skippedReasons },
        assumptions: result.assumptions,
        gate,
        atlas: atlasStatus,
      },
      slots: bag.slots,
      sources: snap.sources,
    };
  }

  private orderSlots(bag: SlotBag, r: ResolvedIntent, result: PlanResult): void {
    bag
      .text("symbol", r.symbol, "user")
      .text("side", r.side, "user")
      .qty("qty", result.qty, PLANNER)
      .usd("notional", result.notionalUsd, PLANNER);
    if (r.deadline !== undefined)
      bag.time("deadline", r.deadline, "user").text("deadlineReading", r.deadlineReading, "slipway.desk");
    if (r.venues) bag.text("venues", r.venues.join(" + "), "user");
    if (r.holdHorizonHours !== undefined) bag.put("holdHours", r.holdHorizonHours, "count", "user");
    for (const v of VENUES) bag.price(`arrival.${v}`, result.arrivalMids[v], BOOK_SOURCE[v]);
  }

  private pick(result: PlanResult, strategyId: string): StrategyQuote {
    const id = strategyId.trim();
    let q: StrategyQuote | null | undefined;
    if (id === "best") q = result.best;
    else if (id === "baseline") q = result.baseline;
    else if (id.startsWith("best:")) q = result.bestByFamily[id.slice(5) as StrategyKind];
    else q = result.candidates.find((c) => c.id === id);
    if (!q) {
      const offer = [result.best?.id, ...Object.values(result.bestByFamily).map((x) => x?.id)].filter(
        Boolean,
      );
      throw new DeskError(
        `strategy "${id}" is not available on current data; available: ${[...new Set(offer)].join(", ") || "none"}`,
        "NOT_FOUND",
        result.sources,
      );
    }
    if (q.violations?.includes("DEADLINE")) {
      throw new DeskError(
        `strategy "${q.id}" finishes after the deadline; pick a feasible one`,
        "BAD_INPUT",
        result.sources,
      );
    }
    return q;
  }

  async buildPlan(
    input: IntentInput,
    profileInput: Profile = DEFAULT_PROFILE,
    strategyId = "best",
  ): Promise<DeskResult<PlanData>> {
    const base = ProfileSchema.parse(profileInput);
    const { snap } = await this.market(input.symbol);
    const { intent, resolved, profile } = this.resolveIntent(input, base, snap);
    const result = this.plan(intent, profile, snap);
    const chosen = this.pick(result, strategyId);
    const { plan, gate } = this.gate(result, chosen.id, profile, snap);
    const keys = await this.keysOf();
    const signed = await signPlan(plan, gate, keys.keys, this.clock());
    const strategy = quoteView(chosen);
    const slices = sliceViews(chosen.slices);
    const planId = planIdOf(signed);
    const expiresAt = signed.issuedAt + TICKET_MAX_AGE_MS;

    const bag = new SlotBag();
    const p = bag.scope("plan");
    p.text("planId", planId, "slipway.signer")
      .time("expires", expiresAt, "slipway.signer")
      .price("arrivalMid", plan.arrivalMid, BOOK_SOURCE[slices[0]?.venue ?? "rtoken"]);
    quoteSlots(p, strategy);
    gateSlots(bag.scope("gate"), gate);
    this.orderSlots(bag.scope("order"), resolved, result);
    const first = slices[0];
    const last = slices.at(-1);
    if (first)
      bag
        .scope("slice0")
        .time("at", first.t, PLANNER)
        .qty("qty", first.qty, PLANNER)
        .text("venue", first.venue, PLANNER)
        .bps("expectedBps", first.expectedBps, PLANNER);
    if (last && last !== first)
      bag
        .scope("sliceLast")
        .time("at", last.t, PLANNER)
        .qty("qty", last.qty, PLANNER)
        .text("venue", last.venue, PLANNER)
        .bps("expectedBps", last.expectedBps, PLANNER);

    return {
      data: {
        planId,
        signedPlan: signed,
        verdict: gate.verdict,
        checks: checkViews(gate),
        strategy,
        alternatives: [
          ...new Map(
            [...Object.values(result.bestByFamily), result.baseline]
              .filter((q): q is StrategyQuote => !!q && q.id !== chosen.id)
              .map((q) => [q.id, quoteView(q)]),
          ).values(),
        ],
        slices,
        expiresAt,
        publicKey: keys.publicKey,
        keyOrigin: keys.origin,
        intent: resolved,
      },
      slots: bag.slots,
      sources: plan.sources,
    };
  }

  async issueTickets(signed: SignedPlan): Promise<DeskResult<TicketsData>> {
    const planId = typeof signed?.hash === "string" ? planIdOf(signed) : "unknown";
    const bag = new SlotBag();
    const refuse = (
      reason: string,
      extra: Partial<Extract<TicketsData, { ok: false }>> = {},
      sources: SourceRef[] = [],
    ): DeskResult<TicketsData> => {
      const verdict = signed?.gate?.verdict ?? null;
      const fixes = signed?.gate ? checkViews(signed.gate).filter((c) => c.status !== "pass") : [];
      bag
        .text("tickets.status", "REFUSED", "slipway.signer")
        .text("tickets.reason", reason, "slipway.signer");
      if (verdict) bag.text("tickets.verdict", verdict.toUpperCase(), GATE);
      fixes.forEach((c, i) => {
        bag.scope(`refusal${i}`).text("code", c.code, GATE).text("detail", c.detail, GATE);
        if (c.fix) bag.scope(`refusal${i}`).text("fix", c.fix, GATE);
      });
      return { data: { ok: false, planId, reason, verdict, fixes, ...extra }, slots: bag.slots, sources };
    };
    const keys = await this.keysOf();
    try {
      await assertTicketable(signed, keys.publicKey, this.clock(), TICKET_MAX_AGE_MS);
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
    const plan = signed.plan;
    let snap: LoadedSnapshot;
    try {
      snap = await this.snapshotOf(plan.intent.symbol);
    } catch (e) {
      return refuse(
        `instrument rules unavailable: ${e instanceof Error ? e.message : String(e)}`,
        {},
        (e as { sources?: SourceRef[] }).sources ?? [],
      );
    }
    const refPx: Partial<Record<Venue, number>> = {};
    for (const v of VENUES) {
      const b = snap.books[v];
      if (b?.bids[0] && b.asks[0]) refPx[v] = mid(b);
    }
    const slices = plan.strategy.slices;
    const worst = Math.max(...slices.map((s) => s.expectedBps), 0);
    const maxSlippageBps = Math.max(15, Math.ceil(2 * worst + 5));
    const tickets = await buildTickets(slices, {
      underlying: plan.intent.symbol,
      rules: snap.rules,
      refPx,
      clientOidPrefix: `sw${signed.hash.slice(0, 10)}`,
      maxSlippageBps,
    });
    const notes: string[] = [];
    const later = tickets.filter((t) => t.t > this.clock() + TICKET_MAX_AGE_MS);
    if (later.length)
      notes.push(
        `${later.length} ticket(s) are scheduled for later: refresh their price cap from the book at send time`,
      );
    const violations = tickets.flatMap((t) => t.violations.map((v) => `#${t.index}: ${v}`));
    if (violations.length)
      return refuse(`ticket validation failed: ${violations.join("; ")}`, { tickets }, snap.sources);
    bag
      .text("tickets.status", "ISSUED (dry run)", "slipway.signer")
      .count("tickets.count", tickets.length, "bitget.agent-sdk")
      .bps("tickets.maxSlippage", maxSlippageBps, "slipway.desk", 0)
      .text("tickets.sdk", tickets[0]?.sdkVersion, "bitget.agent-sdk");
    tickets.slice(0, 3).forEach((t, i) => {
      bag
        .scope(`ticket${i}`)
        .text("bgc", t.bgc, "bitget.agent-sdk")
        .text("kind", t.kind, "bitget.agent-sdk")
        .qty("qty", t.qty, "bitget.agent-sdk")
        .time("at", t.t, PLANNER)
        .price("limitPx", t.limitPx, "bitget.agent-sdk");
    });
    return {
      data: { ok: true, planId, dryRun: true, tickets, maxSlippageBps, notes },
      slots: bag.slots,
      sources: snap.sources,
    };
  }

  async liquidityTide(symbol: string, horizonDays = 7): Promise<DeskResult<TideData>> {
    const { snap, atlas } = await this.market(symbol);
    const now = snap.now;
    const bag = new SlotBag();
    const statsOf = (v: Venue, s: Session) => {
      const st = snap.atlas[atlasKey(snap.symbol, v, s)];
      if (!st) return null;
      return {
        n: st.n,
        spreadBpsP50: st.spreadBps.p50,
        depth10UsdP50: st.depthUsd.b10.p50,
        depth25UsdP50: st.depthUsd.b25.p50,
        depth25UsdP10: st.depthUsd.b25.p10,
        depth50UsdP50: st.depthUsd.b50.p50,
        flowUsdPerMinP50: st.tradeNotionalPerMin.p50,
        sigmaBpsPerSqrtSec: st.sigmaBpsPerSqrtSec,
        halfLifeSec: st.resilience?.halfLifeSec ?? null,
      };
    };
    const timeline = transitions(now, now + horizonDays * 86_400_000, snap.holidays).map((span) => ({
      session: span.session,
      start: span.start,
      end: span.end,
      startNy: nyText(span.start),
      venues: Object.fromEntries(
        VENUES.map((v) => [
          v,
          { tradable: venueTradable(v, span.session, snap.sessions), stats: statsOf(v, span.session) },
        ]),
      ) as Record<Venue, { tradable: boolean; stats: ReturnType<typeof statsOf> }>,
    }));
    const sessions = [...new Set(timeline.map((t) => t.session))];
    const bySession = sessions.map((s) => ({
      session: s,
      rtoken: statsOf("rtoken", s),
      perp: statsOf("perp", s),
    }));
    const live: TideData["live"] = { session: sessionAt(now, snap.holidays).session, venues: {} };
    for (const v of VENUES) {
      const b = snap.books[v];
      if (!b?.bids[0] || !b.asks[0]) continue;
      const d = (bps: number) =>
        (depthWithin(b, "buy", bps).notional + depthWithin(b, "sell", bps).notional) / 2;
      const lv = { spreadBps: spreadBps(b), depth10Usd: d(10), depth25Usd: d(25), depth50Usd: d(50) };
      live.venues[v] = lv;
      bag
        .scope(`now.${v}`)
        .bps("spread", lv.spreadBps, BOOK_SOURCE[v], 2)
        .usd("depth25", lv.depth25Usd, BOOK_SOURCE[v])
        .usd("depth10", lv.depth10Usd, BOOK_SOURCE[v]);
    }
    bag
      .text("now.session", live.session, "bitget.reality.session")
      .text("depthBand", "±25 bp of mid, per side", "slipway.desk");
    for (const row of bySession) {
      for (const v of VENUES) {
        const st = row[v];
        if (!st) continue;
        bag
          .scope(`${row.session}.${v}`)
          .usd("depth25", st.depth25UsdP50, "slipway.atlas")
          .bps("spread", st.spreadBpsP50, "slipway.atlas", 2)
          .usd("flowPerMin", st.flowUsdPerMinP50, "slipway.atlas")
          .count("samples", st.n, "slipway.atlas");
      }
    }
    for (const v of VENUES) {
      const deepest = bySession
        .filter((r) => r[v])
        .sort((a, b) => (b[v]?.depth25UsdP50 ?? 0) - (a[v]?.depth25UsdP50 ?? 0))[0];
      if (deepest?.[v])
        bag
          .scope(`deepest.${v}`)
          .text("session", deepest.session, "slipway.atlas")
          .usd("depth25", deepest[v]?.depth25UsdP50, "slipway.atlas")
          .bps("spread", deepest[v]?.spreadBpsP50, "slipway.atlas", 2);
      const nextOpen = timeline.find((t) => t.venues[v].tradable && t.start > now);
      if (nextOpen)
        bag
          .scope(`next.${v}`)
          .text("session", nextOpen.session, "bitget.reality.session")
          .time("start", nextOpen.start, "bitget.reality.session");
    }
    const atlasStatus = this.atlasStatus(atlas, snap);
    bag.text("atlas", atlasStatus.status, atlas.source.id);
    return {
      data: {
        symbol: snap.symbol,
        now,
        nowNy: nyText(now),
        live,
        timeline,
        bySession,
        atlas: atlasStatus,
        units: { depth: "USD per side within ±bps of mid", spread: "bps" },
      },
      slots: bag.slots,
      sources: snap.sources,
    };
  }

  async trackRecord(symbol?: string): Promise<DeskResult<TrackData>> {
    const got = await this.artifacts.trackRecord();
    const bag = new SlotBag();
    const id = got.source.id;
    bag.text("track.status", got.source.status, id);
    if (!got.data) {
      return {
        data: {
          status: "unavailable",
          since: got.source.since ?? null,
          detail: got.source.detail ?? null,
          record: null,
        },
        slots: bag.slots,
        sources: [got.source],
      };
    }
    let record = got.data as Record<string, unknown>;
    const sym = symbol ? normalizeSymbol(symbol) : null;
    if (sym && record.bySymbol && typeof record.bySymbol === "object") {
      const own = (record.bySymbol as Record<string, unknown>)[sym];
      record = { ...record, bySymbol: own ? { [sym]: own } : {} };
    }
    if (!trackSlots(record, bag.scope("track"), id)) flattenNumbers(record, bag.scope("track"), id);
    return {
      data: { status: got.source.status, since: null, detail: got.source.detail ?? null, record },
      slots: bag.slots,
      sources: [got.source],
    };
  }

  explain(topic: string): DeskResult<ExplainData> {
    const hit = explainEntry(topic);
    const bag = new SlotBag();
    if (!hit)
      return {
        data: { topic, found: false, title: null, text: null, topics: TOPICS },
        slots: bag.slots,
        sources: [],
      };
    hit.entry.slots?.(bag.scope("explain"));
    return {
      data: { topic: hit.key, found: true, title: hit.entry.title, text: hit.entry.text, topics: TOPICS },
      slots: bag.slots,
      sources: [],
    };
  }

  async research(symbol: string): Promise<DeskResult<ResearchData>> {
    const parsed = SymbolSchema.safeParse(symbol);
    if (!parsed.success) throw new DeskError(`"${symbol}" is not a ticker`, "BAD_INPUT");
    const u = normalizeSymbol(parsed.data);
    const now = this.clock();
    const ms = this.opts.researchBudgetMs ?? 6_000;
    const off = (id: string): Promise<Optional<never>> =>
      Promise.resolve({
        data: null,
        source: { id, status: "unavailable", asOf: null, since: now, detail: "source disabled" },
        latencyMs: 0,
      });
    const shared = sharedResearch(this.opts);
    const { dataMcp, signal, rest } = shared;
    const bars = rest
      .candles("perp", u, { interval: "1h", limit: 24 })
      .then((r): Optional<Candle[]> => r)
      .catch(
        (e: unknown): Optional<Candle[]> => ({
          data: null,
          source: (e as { source?: SourceRef }).source ?? {
            id: "bitget.mix.candles",
            status: "unavailable",
            asOf: null,
            since: now,
          },
          latencyMs: 0,
        }),
      );
    const [quote, news, fearGreed, perp24h, boll, kl, own, feed] = await Promise.all([
      dataMcp
        ? budgeted(dataMcp.equityQuote(u), ms, "bitget-mcp.equity_price_quote", now)
        : off("bitget-mcp.equity_price_quote"),
      dataMcp
        ? budgeted(dataMcp.news("stocks", { pageSize: 5 }), ms, "bitget-mcp.news_label_search", now)
        : off("bitget-mcp.news_label_search"),
      dataMcp
        ? budgeted(dataMcp.marketFearGreed(), ms, "bitget-mcp.sentiment_market_fear_greed", now)
        : off("bitget-mcp.sentiment_market_fear_greed"),
      signal
        ? budgeted(signal.perp24h(u), ms, "bitget-signal.crypto_derivatives", now)
        : off("bitget-signal.crypto_derivatives"),
      signal
        ? budgeted(signal.bollingerAudit(u, "1h", 20, 60), ms, "bitget-signal.technical_analysis", now)
        : off("bitget-signal.technical_analysis"),
      signal
        ? budgeted(signal.klines(u, "1h", 60), ms, "bitget-signal.crypto_derivatives", now)
        : off("bitget-signal.crypto_derivatives"),
      budgeted(bars, ms, "bitget.mix.candles", now),
      signal
        ? budgeted(signal.newsFeed(u, 2), ms, "bitget-signal.news_feed", now)
        : off("bitget-signal.news_feed"),
    ]);
    const bag = new SlotBag();
    const flags: { code: string; source: string; severity: string; detail: string }[] = [];

    const q = quote.data;
    if (q) {
      const s = bag.scope("quote");
      s.price("last", q.last, quote.source.id)
        .pct("change", q.changePct === null ? null : q.changePct / 100, quote.source.id, 2, true)
        .seconds("staleness", q.cashStalenessSec, quote.source.id)
        .time("sipAt", q.sipTs, quote.source.id);
    }
    const fg = fearGreed.data;
    if (fg)
      bag
        .scope("fearGreed")
        .count("score", fg.score, fearGreed.source.id)
        .text("rating", fg.rating, fearGreed.source.id);
    const p24 = perp24h.data;
    if (p24) {
      bag
        .scope("perp24h")
        .price("last", p24.last, perp24h.source.id)
        .price("high", p24.high, perp24h.source.id)
        .price("low", p24.low, perp24h.source.id)
        .pct("change", p24.changePct / 100, perp24h.source.id, 2, true)
        .usd("quoteVolume", p24.quoteVolume, perp24h.source.id);
    }
    let technicals: ResearchData["technicals"] = null;
    const ownBars = own.data;
    if (ownBars && ownBars.length > 15) {
      const closes = ownBars.map((b) => b.close);
      const rets = closes.slice(1).map((c, i) => Math.log(c / (closes[i] as number)) * 1e4);
      const meanR = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / Math.max(1, rets.length - 1));
      technicals = {
        source: own.source.id,
        bars: ownBars.length,
        rsi14: rsi(closes, 14),
        atr14: atr(ownBars, 14),
        hourlyVolBps: sd,
        rangeHigh: Math.max(...ownBars.map((b) => b.high)),
        rangeLow: Math.min(...ownBars.map((b) => b.low)),
      };
      bag
        .scope("tech")
        .put("rsi", technicals.rsi14, "price", own.source.id, { dp: 1 })
        .price("atr", technicals.atr14, own.source.id)
        .bps("hourlyVol", technicals.hourlyVolBps, own.source.id)
        .price("high", technicals.rangeHigh, own.source.id)
        .price("low", technicals.rangeLow, own.source.id)
        .count("bars", technicals.bars, own.source.id);
    }
    const audit = boll.data;
    if (audit) {
      bag
        .scope("bollinger")
        .price("upper", audit.recomputed.upper, "slipway.recomputed")
        .price("middle", audit.recomputed.middle, "slipway.recomputed")
        .price("lower", audit.recomputed.lower, "slipway.recomputed");
      flags.push(...audit.flags);
    }
    if (kl.data && ownBars) {
      const f = venueCheck(kl.data, ownBars);
      if (f) flags.push(f);
    }
    flags.forEach((f, i) => {
      bag.scope(`flag${i}`).text("code", f.code, f.source).text("detail", f.detail, f.source);
    });
    const headlines = [
      ...(news.data ?? [])
        .slice(0, 5)
        .map((n) => ({ title: n.title, at: n.publishedAt, source: news.source.id })),
      ...(feed.data ?? [])
        .slice(0, 3)
        .map((n) => ({ title: n.title, at: n.publishedAt, source: feed.source.id })),
    ];
    headlines.forEach((h, i) => {
      bag.scope(`news${i}`).text("title", h.title, h.source).time("at", h.at, h.source);
    });
    const sources = [
      quote.source,
      news.source,
      fearGreed.source,
      perp24h.source,
      boll.source,
      kl.source,
      own.source,
      feed.source,
    ];
    const unavailable = sources.filter((s) => s.status === "unavailable").map((s) => s.id);
    bag.text(
      "unavailable",
      unavailable.length ? [...new Set(unavailable)].join(", ") : "none",
      "slipway.desk",
    );
    return {
      data: {
        symbol: u,
        quote: q ?? null,
        fearGreed: fg ?? null,
        perp24h: p24 ?? null,
        technicals,
        bollinger: audit ? { recomputed: audit.recomputed, reported: audit.reported } : null,
        headlines,
        flags,
        unavailable: [...new Set(unavailable)],
      },
      slots: bag.slots,
      sources,
    };
  }
}

let researchDefaults: { dataMcp: BitgetDataMcp; signal: SignalMcp; rest: BitgetRest } | null = null;

function sharedResearch(o: DeskOptions): {
  dataMcp: BitgetDataMcp | null;
  signal: SignalMcp | null;
  rest: BitgetRest;
} {
  if (!researchDefaults) {
    const cache = new SourceCache(
      process.env.SLIPWAY_CACHE_DIR ? { dir: process.env.SLIPWAY_CACHE_DIR } : {},
    );
    researchDefaults = {
      dataMcp: new BitgetDataMcp({ cache }),
      signal: new SignalMcp({ cache }),
      rest: new BitgetRest(),
    };
  }
  return {
    dataMcp: o.dataMcp === undefined ? researchDefaults.dataMcp : o.dataMcp,
    signal: o.signal === undefined ? researchDefaults.signal : o.signal,
    rest: o.rest ?? researchDefaults.rest,
  };
}

const UNIT_HINTS: [RegExp, "bps" | "usd" | "pct" | "count" | "seconds"][] = [
  [/bps$|^ci\d*$/i, "bps"],
  [/usd$/i, "usd"],
  [/(coverage|rate|share|ratio|pct)$/i, "pct"],
  [/^(n|count|entries|orders|wins|losses|ties|graded|ungraded|pending|inside)$|count$/i, "count"],
  [/sec$/i, "seconds"],
];

/**
 * Leaves of an artifact become slots named by their path: numbers with units inferred from key suffixes (array
 * elements inherit their array's key), short strings as text. Used when an artifact has no curated projection.
 */
export function flattenNumbers(
  value: unknown,
  bag: SlotBag,
  source: string,
  path: string[] = [],
  budget = { left: 200 },
  hintKey?: string,
): void {
  if (budget.left <= 0) return;
  const key = hintKey ?? (path.at(-1) as string);
  if (typeof value === "number" && Number.isFinite(value) && path.length) {
    const unit = UNIT_HINTS.find(([re]) => re.test(key))?.[1];
    const name = path.join(".");
    if (/^(generatedAt|asOf|from|to|ts|at|tapeEnd)$/i.test(key) && value > 1e11)
      bag.time(name, value, source);
    else if (unit === "pct") bag.pct(name, value, source, 1);
    else if (unit === "bps") bag.bps(name, value, source, 1, /bias|diff/i.test(key));
    else if (unit) bag.put(name, value, unit, source);
    else if (Number.isInteger(value)) bag.count(name, value, source);
    else bag.put(name, value, "price", source, { dp: 2 });
    budget.left--;
    return;
  }
  if (typeof value === "string" && path.length && value.length <= 80 && !/^[0-9a-f]{32,}$/i.test(value)) {
    bag.text(path.join("."), value, source);
    budget.left--;
    return;
  }
  if (Array.isArray(value))
    value.slice(0, 50).forEach((v, i) => {
      flattenNumbers(v, bag, source, [...path, `i${i}`], budget, typeof v === "object" ? undefined : key);
    });
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) flattenNumbers(v, bag, source, [...path, k], budget);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Curated slots for the tape's graded track record: counts, the primary label's accuracy rows and its
 * head-to-head against the baselines. Returns false when the artifact does not have that shape.
 */
function trackSlots(r: Rec, bag: SlotBag, source: string): boolean {
  const counts = rec(r.counts);
  const accuracy = rec(r.accuracy);
  const h2h = rec(r.headToHead);
  if (!counts || !accuracy || !h2h) return false;
  const label = typeof r.primaryLabel === "string" ? r.primaryLabel : (Object.keys(accuracy)[0] ?? "");
  bag.time("generatedAt", num(r.generatedAt), source).text("label", label, source);
  const proto = rec(r.protocol);
  if (proto) bag.text("protocol", `${String(proto.name)} v${String(proto.version)}`, source);
  for (const [who, c] of Object.entries(counts)) {
    const cc = rec(c);
    if (!cc) continue;
    for (const k of ["entries", "graded", "ungraded", "pending"])
      bag.count(`counts.${who}.${k}`, num(cc[k]), source);
  }
  Object.entries(rec(r.ungradedReasons) ?? {})
    .sort((a, b) => (num(b[1]) ?? 0) - (num(a[1]) ?? 0))
    .slice(0, 4)
    .forEach(([reason, n], i) => {
      bag.scope(`ungraded${i}`).text("reason", reason, source).count("n", num(n), source);
    });
  const rows = Array.isArray(accuracy[label]) ? (accuracy[label] as unknown[]) : [];
  rows.slice(0, 12).forEach((row, i) => {
    const a = rec(row);
    if (!a) return;
    const cov = rec(a.coverage);
    bag
      .scope(`acc${i}`)
      .text(
        "bucket",
        [a.scope, a.venue, a.session, a.horizon].filter((x) => typeof x === "string").join(" · "),
        source,
      )
      .count("n", num(a.n), source)
      .bps("mae", num(a.maeBps), source)
      .bps("bias", num(a.biasBps), source, 1, true)
      .pct("coverage", num(cov?.rate), source, 1)
      .count("inside", num(cov?.inside), source);
  });
  for (const [vs, v] of Object.entries(rec(h2h[label]) ?? {})) {
    const h = rec(v);
    if (!h) continue;
    const ci = Array.isArray(h.ci95) ? h.ci95 : [];
    bag
      .scope(`h2h.${vs}`)
      .count("n", num(h.n), source)
      .count("wins", num(h.wins), source)
      .count("losses", num(h.losses), source)
      .count("ties", num(h.ties), source)
      .pct("winRate", num(h.winRate), source, 0)
      .bps("meanDiff", num(h.meanDiffBps), source, 1, true)
      .bps("ci95lo", num(ci[0]), source, 1, true)
      .bps("ci95hi", num(ci[1]), source, 1, true);
  }
  return true;
}
