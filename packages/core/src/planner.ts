import { mid } from "./book.js";
import { avoidedSlices, closedSlices, eventConflicts, participationBreaches } from "./constraints.js";
import { DEFAULT_PRIOR_HALF_LIFE_SEC, type PlannedSlice, priceSchedule, type Schedule } from "./cost.js";
import { nextSessionStart, sessionAt, venueTradable } from "./session.js";
import type {
  Fees,
  MarketSnapshot,
  OrderIntent,
  Plan,
  Profile,
  Session,
  Side,
  SourceRef,
  StrategyKind,
  StrategyQuote,
  Urgency,
  Venue,
  Violation,
} from "./types.js";

export const MODEL_VERSION = "slipway-core/0.1.0";
export const LAMBDA: Record<Urgency, number> = { patient: 0.25, normal: 1, urgent: 3 };

export interface PlannerOptions {
  priorHalfLifeSec: number;
  sliceCounts: number[];
  intervalsSec: number[];
  passiveRestSec: number[];
  twapChildNotionalUsd: number; // Bitget-app style TWAP clip size for the baseline
  regularOpenSkipMin: number;
  maxWaitHours: number;
  rotationSlices: number[];
  rotationIntervalSec: number;
}

export const PLANNER_DEFAULTS: PlannerOptions = {
  priorHalfLifeSec: DEFAULT_PRIOR_HALF_LIFE_SEC,
  sliceCounts: [2, 3, 4, 6, 8, 12, 16, 24],
  intervalsSec: [10, 30, 60, 120, 300, 900],
  passiveRestSec: [60, 300, 900],
  twapChildNotionalUsd: 5_000,
  regularOpenSkipMin: 15,
  maxWaitHours: 72,
  rotationSlices: [1, 4, 12],
  rotationIntervalSec: 60,
};

export interface PlanResult {
  intent: OrderIntent;
  profileName: string;
  now: number;
  qty: number;
  notionalUsd: number;
  arrivalMids: Partial<Record<Venue, number>>;
  basisBps: number | null; // rToken mid vs perp mid, reported not charged
  lambda: number;
  candidates: StrategyQuote[]; // every priced strategy, by score then id; infeasible ones flagged
  bestByFamily: Partial<Record<StrategyKind, StrategyQuote>>;
  best: StrategyQuote | null;
  baseline: StrategyQuote | null; // TWAP-60s on the primary venue
  skipped: { id: string; reason: string }[];
  assumptions: string[];
  sources: SourceRef[];
}

const SESSION_ORDER: Session[] = ["pre_market", "regular", "after_hours", "overnight", "weekend"];
const opposite = (s: Side): Side => (s === "buy" ? "sell" : "buy");
const venueName = (v: Venue, symbol: string) => (v === "rtoken" ? `r${symbol}` : `${symbol} perp`);

const sliced = (
  t0: number,
  venue: Venue,
  side: Side,
  qty: number,
  n: number,
  tauSec: number,
): PlannedSlice[] =>
  Array.from({ length: n }, (_, k) => ({
    t: t0 + k * tauSec * 1000,
    venue,
    side,
    qty: qty / n,
    mode: "market" as const,
  }));

interface Draft {
  id: string;
  kind: StrategyKind;
  label: string;
  schedule: Schedule;
  notes?: string[];
}

export function planExecution(
  intent: OrderIntent,
  profile: Profile,
  snap: MarketSnapshot,
  options: Partial<PlannerOptions> = {},
): PlanResult {
  if (intent.symbol !== snap.symbol)
    throw new Error(`intent is for ${intent.symbol}, market data for ${snap.symbol}`);
  const o = { ...PLANNER_DEFAULTS, ...options };
  const lambda = LAMBDA[profile.urgency];
  const fees: Record<Venue, Fees> = { ...snap.fees, ...profile.feeOverride };
  const now = snap.now;
  const nowSession = sessionAt(now, snap.holidays).session;
  const assumptions: string[] = [];

  const arrivalMids: Partial<Record<Venue, number>> = {};
  for (const v of ["rtoken", "perp"] as const) {
    const b = snap.books[v];
    if (b) arrivalMids[v] = mid(b);
  }
  const refMid = arrivalMids.rtoken ?? arrivalMids.perp;
  if (refMid === undefined) throw new Error(`no live book for ${intent.symbol}`);
  const qty = intent.qty ?? (intent.notionalUsd !== undefined ? intent.notionalUsd / refMid : Number.NaN);
  if (!(qty > 0)) throw new RangeError("intent needs a positive size (qty or notionalUsd)");
  const notionalUsd = qty * refMid;
  const side = intent.side;

  const requested = intent.venues ?? (["rtoken", "perp"] as Venue[]);
  if (requested.includes("perp") && !profile.allowPerp) assumptions.push("perp venue disabled by profile");
  const venues = requested.filter((v) => (v !== "perp" || profile.allowPerp) && snap.books[v]);
  for (const v of requested)
    if (!snap.books[v]) assumptions.push(`no live ${v} book; ${v} strategies not priced`);
  const basisBps =
    arrivalMids.rtoken !== undefined && arrivalMids.perp !== undefined
      ? (arrivalMids.rtoken / arrivalMids.perp - 1) * 1e4
      : null;
  if (basisBps !== null)
    assumptions.push(
      `costs are vs each venue's own arrival mid; rToken/perp basis ${basisBps.toFixed(1)} bps is reported, not charged`,
    );

  const candidates: StrategyQuote[] = [];
  const skipped: { id: string; reason: string }[] = [];

  const quote = (d: Draft): StrategyQuote | { reason: string } => {
    const r = priceSchedule(d.schedule, snap, { fees, priorHalfLifeSec: o.priorHalfLifeSec });
    if (!r.ok) return { reason: r.reason };
    const e = r.estimate;
    const times = e.slices.map((s) => s.t);
    const startsAt = Math.min(...times);
    const endsAt = Math.max(...times);
    const notes = new Set([...e.assumptions, ...(d.notes ?? [])]);
    if (e.slices.some((s) => s.venue === "perp")) notes.add("perp treated as tradable 24/7");
    const violations: Violation[] = [];
    if (intent.deadline !== undefined && endsAt > intent.deadline) violations.push("DEADLINE");
    if (e.exhausted) violations.push("BOOK_EXHAUSTED");
    if (closedSlices(e.slices, snap).length) violations.push("VENUE_CLOSED");
    if (avoidedSlices(e.slices, profile).length) violations.push("PROFILE");
    const p = participationBreaches(e.slices, snap, profile);
    if (p.breaches.length) violations.push("PARTICIPATION");
    for (const w of p.waived) notes.add(`no recorded prints on ${w}; participation cap not applicable`);
    if (eventConflicts(startsAt, endsAt, snap.events, snap.symbol, profile).length)
      violations.push("EVENT_WINDOW");
    return {
      id: d.id,
      kind: d.kind,
      label: d.label,
      slices: e.slices,
      qty,
      notionalUsd: qty * (arrivalMids[d.schedule.entry[0]?.venue ?? "rtoken"] ?? refMid),
      expectedBps: e.expectedBps,
      sdBps: e.sdBps,
      p10Bps: e.p10Bps,
      p90Bps: e.p90Bps,
      score: e.expectedBps + lambda * e.sdBps,
      components: e.components,
      startsAt,
      endsAt,
      assumptions: [...notes],
      feasible: violations.length === 0,
      violations,
    };
  };

  const add = (d: Draft) => {
    const q = quote(d);
    if ("reason" in q) skipped.push({ id: d.id, reason: q.reason });
    else candidates.push(q);
  };

  // Several sub-schedules compete for one slot (e.g. how to execute after a wait); keep the best.
  const addBestOf = (drafts: Draft[]) => {
    let best: StrategyQuote | undefined;
    let firstReason: { id: string; reason: string } | undefined;
    for (const d of drafts) {
      const q = quote(d);
      if ("reason" in q) {
        firstReason ??= { id: d.id, reason: q.reason };
        continue;
      }
      if (!best || rank(q) < rank(best) || (rank(q) === rank(best) && q.id < best.id)) best = q;
    }
    if (best) candidates.push(best);
    else if (firstReason) skipped.push(firstReason);
  };

  const sessionStart = (target: Session) => {
    const start = nextSessionStart(now, target, snap.holidays);
    return target === "regular" ? start + o.regularOpenSkipMin * 60_000 : start;
  };
  const targets = (venue: Venue) =>
    SESSION_ORDER.filter((s) => s !== nowSession && venueTradable(venue, s, snap.sessions))
      .map((s) => ({ session: s, at: sessionStart(s) }))
      .filter((x) => x.at - now <= o.maxWaitHours * 3_600_000);

  const grid = (t0: number, venue: Venue, prefix: string, labelPrefix: string): Draft[] => [
    {
      id: `${prefix}immediate`,
      kind: "immediate",
      label: `${labelPrefix}market order on ${venueName(venue, snap.symbol)}`,
      schedule: { parentQty: qty, entry: sliced(t0, venue, side, qty, 1, 0) },
    },
    ...o.sliceCounts.flatMap((n) =>
      o.intervalsSec.map((tau) => ({
        id: `${prefix}n${n}:t${tau}`,
        kind: "sliced" as const,
        label: `${labelPrefix}${n} slices every ${tau}s on ${venueName(venue, snap.symbol)}`,
        schedule: { parentQty: qty, entry: sliced(t0, venue, side, qty, n, tau) },
      })),
    ),
  ];

  for (const venue of venues) {
    const name = venueName(venue, snap.symbol);
    if (venueTradable(venue, nowSession, snap.sessions)) {
      for (const d of grid(now, venue, "", "")) {
        add({ ...d, id: d.kind === "immediate" ? `immediate:${venue}` : `sliced:${venue}:${d.id}` });
      }
      const clips = Math.ceil(notionalUsd / o.twapChildNotionalUsd);
      if (clips >= 2) {
        add({
          id: `twap60:${venue}:n${clips}`,
          kind: "sliced",
          label: `TWAP 60s baseline: ${clips} clips of ~$${o.twapChildNotionalUsd.toLocaleString("en-US")} on ${name}`,
          schedule: { parentQty: qty, entry: sliced(now, venue, side, qty, clips, 60) },
          notes: [`TWAP baseline clip size $${o.twapChildNotionalUsd} (planner option)`],
        });
      }
      for (const rest of o.passiveRestSec) {
        add({
          id: `passive:${venue}:T${rest}`,
          kind: "passive",
          label: `Rest at the touch for ${rest}s on ${name}, then cross the remainder`,
          schedule: { parentQty: qty, entry: [{ t: now, venue, side, qty, mode: "passive", restSec: rest }] },
        });
      }
    } else {
      assumptions.push(`${name} not tradable in ${nowSession}; only waits are priced on it`);
    }
    for (const { session, at } of targets(venue)) {
      const when = sessionAt(at, snap.holidays).nyLocal;
      addBestOf(
        grid(at, venue, `wait:${venue}:${session}:`, `Wait for ${session} (${when} NY), then `).map((d) => ({
          ...d,
          kind: "wait" as const,
        })),
      );
    }
  }

  if (profile.allowPerp && venues.includes("perp") && venues.includes("rtoken")) {
    for (const { session, at } of targets("rtoken")) {
      const when = sessionAt(at, snap.holidays).nyLocal;
      addBestOf(
        o.rotationSlices.map((m) => ({
          id: `perp_then_rotate:${session}:r${m}`,
          kind: "perp_then_rotate" as const,
          label: `Perp now, rotate into r${snap.symbol} at ${session} (${when} NY) in ${m} step${m > 1 ? "s" : ""}`,
          schedule: {
            parentQty: qty,
            entry: sliced(now, "perp", side, qty, 1, 0),
            rotation: {
              out: sliced(at, "perp", opposite(side), qty, m, o.rotationIntervalSec),
              in: sliced(at, "rtoken", side, qty, m, o.rotationIntervalSec),
            },
          },
        })),
      );
    }
  }

  const hold = intent.holdHorizonHours;
  if (profile.allowPerp && venues.includes("perp") && hold !== undefined && hold > 0) {
    add({
      id: `perp_hold:h${hold}:immediate`,
      kind: "perp_hold",
      label: `Perp now and hold ${hold}h (funding included)`,
      schedule: {
        parentQty: qty,
        entry: sliced(now, "perp", side, qty, 1, 0),
        perpHoldUntil: now + hold * 3_600_000,
      },
      notes: ["perp exit cost after the hold not included"],
    });
  }

  candidates.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const feasible = candidates.filter((c) => c.feasible);
  const bestByFamily: Partial<Record<StrategyKind, StrategyQuote>> = {};
  for (const c of feasible) bestByFamily[c.kind] ??= c;
  const primary = venues.find((v) => venueTradable(v, nowSession, snap.sessions));
  return {
    intent,
    profileName: profile.name,
    now,
    qty,
    notionalUsd,
    arrivalMids,
    basisBps,
    lambda,
    candidates,
    bestByFamily,
    best: feasible[0] ?? null,
    baseline: candidates.find((c) => primary !== undefined && c.id.startsWith(`twap60:${primary}:`)) ?? null,
    skipped,
    assumptions,
    sources: snap.sources,
  };
}

// Feasible before infeasible, then by score.
const rank = (q: StrategyQuote) => (q.feasible ? 0 : 1e12) + q.score;

export function buildPlan(result: PlanResult, strategyId: string, modelVersion = MODEL_VERSION): Plan {
  const strategy = result.candidates.find((c) => c.id === strategyId);
  if (!strategy) throw new Error(`unknown strategy ${strategyId}`);
  const venue = strategy.slices[0]?.venue ?? "rtoken";
  const arrivalMid = result.arrivalMids[venue];
  if (arrivalMid === undefined) throw new Error(`no arrival mid for ${venue}`);
  return {
    intent: result.intent,
    profileName: result.profileName,
    arrivalMid,
    strategy,
    createdAt: result.now,
    modelVersion,
    sources: result.sources,
  };
}
