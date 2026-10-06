// Grade job (every 5 min on the VM): grade newly due forecasts of both chains, replay source ablations for finished
// batches, aggregate everything into derived/track-record.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { BitgetRest } from "@slipway/bitget";
import {
  type ForecastEntry,
  type MarketSnapshot,
  mid,
  sessionAt,
  type Venue,
  venueTradable,
} from "@slipway/core";
import type { AtlasDoc } from "../atlas/build.js";
import { PROTOCOL_HASH, type Protocol } from "../eval/protocol.js";
import type { BatchManifest, SnapshotBundle } from "../eval/run.js";
import { CHAINS, type Chain, chainIndex, loadObject, loadSummaryCache, saveSummaryCache } from "../ledger.js";
import { nearestBooks } from "../read.js";
import { HOUR_MS, hourStart, type TapeSource } from "../source.js";
import type { ObjectStore } from "../store.js";
import { ABLATIONS, replayAblations } from "./ablation.js";
import {
  DUE_AFTER_MS,
  evalContext,
  type Graded,
  gradePlans,
  groupPlans,
  lastTime,
  MATCH_WINDOW_MS,
  type PlanContext,
  type PlanEntries,
  realizeJobs,
  type ScheduleOutcome,
  scheduleFromQuote,
} from "./grade.js";
import { orderRealized, type ScheduleSlice } from "./realize.js";
import {
  AccuracyAccumulator,
  type AccuracyRow,
  type CalibrationRow,
  type Comparison,
  calibration,
  compare,
  LABELS,
  type LossRow,
  lossesOf,
  orderOutcomes,
  summarize,
} from "./report.js";

export interface GradeJobOptions {
  store: ObjectStore; // mirrored bucket
  source: TapeSource;
  work: string;
  protocol: Protocol;
  atlas: AtlasDoc;
  rest: BitgetRest;
  now: number;
  publish?: boolean;
  log?: (m: string) => void;
}

export interface AblationRow {
  source: string;
  fallback: string;
  orders: number;
  changed: number;
  changedShare: number;
  deltaRealizedBps: { n: number; mean: number; ci95: [number, number] } | null; // chosen' − chosen, changed orders
  deltaAbsErrorBps: { n: number; mean: number } | null;
}

export interface TrackRecord {
  generatedAt: number;
  protocol: { name: string; version: number; hash: string };
  tapeEnd: number | null;
  primaryLabel: "REPRODUCIBLE";
  labels: typeof LABELS;
  counts: Record<Chain, { entries: number; graded: number; ungraded: number; pending: number }>;
  ungradedReasons: Record<string, number>;
  accuracy: Record<string, AccuracyRow[]>;
  headToHead: Record<string, { vsImmediate: Comparison; vsTwap60: Comparison }>;
  calibration: Record<string, CalibrationRow[]>;
  ablation: { batches: number; orders: number; replayMatchesRegistered: number; sources: AblationRow[] };
  losses: LossRow[];
  anchoring: { anchoredBeforeOutcome: number; ledgerTimestampedOnly: number };
  notes: string[];
}

const flat = (name: string) => name.replace(/[/\\]/g, "__");

/** Per-entry grades of one ledger object, published next to the ledger so anyone can audit or re-grade them. */
export const gradesName = (ledgerObject: string) =>
  `grades/${ledgerObject.replace(/^ledger\//, "").replace(/\.jsonl$/, ".json")}`;

interface OrderMeta {
  key: string;
  session: string;
  symbol: string;
  notionalUsd: number;
  primary: string;
}

interface EvalIndex {
  plans: Map<string, { batchId: string; order: number; roles: string[] }>;
  manifests: Map<string, BatchManifest>;
}

async function evalIndex(store: ObjectStore): Promise<EvalIndex> {
  const plans: EvalIndex["plans"] = new Map();
  const manifests: EvalIndex["manifests"] = new Map();
  for (const name of await store.list("eval/batches/")) {
    const got = await store.get(name);
    if (!got) continue;
    const m = JSON.parse(got.data.toString()) as BatchManifest;
    manifests.set(m.batchId, m);
    for (const o of m.orders) {
      for (const p of o.plans) {
        const roles = Object.entries(o.roles)
          .filter(([, id]) => id === p.strategyId)
          .map(([r]) => r);
        plans.set(p.planHash, { batchId: m.batchId, order: o.i, roles });
      }
    }
  }
  return { plans, manifests };
}

class Bundles {
  private readonly cache = new Map<string, SnapshotBundle>();
  constructor(private readonly store: ObjectStore) {}
  async get(m: BatchManifest): Promise<SnapshotBundle | null> {
    const hit = this.cache.get(m.batchId);
    if (hit) return hit;
    const got = await this.store.get(m.snapshotObject);
    if (!got) return null;
    const b = JSON.parse(gunzipSync(got.data).toString()) as SnapshotBundle;
    if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(m.batchId, b);
    return b;
  }
}

/** Hour files are final (and synced to the public bucket) this long after the hour ends. */
export const HOUR_FINAL_AFTER_MS = 5 * 60_000;

/**
 * Grades only use closed hours, so every graded number can be reproduced from the public tape: the open hour on the
 * VM is ahead of its last upload. Returns the end of the newest closed hour present in the tape.
 */
export async function gradableUntil(source: TapeSource, now: number): Promise<number> {
  const lastClosedEnd = Math.floor((now - HOUR_FINAL_AFTER_MS) / HOUR_MS) * HOUR_MS;
  const closed = (await source.hours("books")).filter((h) => hourStart(h) + HOUR_MS <= lastClosedEnd);
  const last = closed.at(-1);
  return last ? hourStart(last) + HOUR_MS : 0;
}

/** Primary (baseline) venue of an eval order, as the planner picks it: rToken if tradable now, else perp. */
export function primaryVenue(snap: MarketSnapshot): Venue {
  const s = sessionAt(snap.now, snap.holidays).session;
  return snap.books.rtoken && venueTradable("rtoken", s, snap.sessions) ? "rtoken" : "perp";
}

export async function runGradeJob(o: GradeJobOptions): Promise<TrackRecord> {
  const log = o.log ?? (() => {});
  const end = await gradableUntil(o.source, o.now);
  const resultsDir = join(o.work, "grade", "results");
  await mkdir(resultsDir, { recursive: true });
  const idx = await evalIndex(o.store);
  const bundles = new Bundles(o.store);
  const fees = new Map<string, Record<Venue, { maker: number; taker: number }>>();
  const funding = new Map<string, { nextFundingTime: number; intervalHours: number } | null>();

  const traderContext = async (p: PlanEntries): Promise<PlanContext | { missing: string }> => {
    const sym = p.order.symbol;
    if (!fees.has(sym)) {
      try {
        const [s, c] = await Promise.all([o.rest.spotSymbolInfo(sym), o.rest.perpContract(sym)]);
        fees.set(sym, { rtoken: s.data.fees, perp: c.data.fees });
        const f = await o.rest.currentFunding(sym);
        funding.set(sym, { nextFundingTime: f.data.nextFundingTime, intervalHours: f.data.intervalHours });
      } catch (e) {
        return { missing: `fees unavailable: ${(e as Error).message}` };
      }
    }
    const v0 = p.slices[0]?.entry.venue as Venue | undefined;
    const arrivalMid: Partial<Record<Venue, number>> = {};
    if (v0) arrivalMid[v0] = p.order.arrivalMid;
    for (const v of new Set(p.slices.map((s) => s.entry.venue as Venue))) {
      if (arrivalMid[v] !== undefined) continue;
      const [m] = await nearestBooks(o.source, [{ venue: v, symbol: sym, ts: p.order.at }], MATCH_WINDOW_MS);
      if (!m) return { missing: `no recorded ${v} book at arrival for the arrival mid` };
      arrivalMid[v] = mid(m.book);
    }
    return {
      arrivalMid,
      fees: fees.get(sym) as Record<Venue, { maker: number; taker: number }>,
      atlas: o.atlas.atlas,
      funding: funding.get(sym) ?? null,
    };
  };

  const evalContextOf = async (p: PlanEntries): Promise<PlanContext | { missing: string }> => {
    const ref = idx.plans.get(p.planHash);
    const m = ref ? idx.manifests.get(ref.batchId) : undefined;
    if (!ref || !m) return { missing: "batch manifest not found for this plan" };
    const b = await bundles.get(m);
    const snap = b?.snapshots[p.order.symbol];
    if (!snap) return { missing: "saved snapshot not found for this plan" };
    return evalContext(snap, ref);
  };

  const counts = {} as TrackRecord["counts"];
  const anchors = await anchoredWindows(o.store);
  const acc = Object.fromEntries(LABELS.map((l) => [l, new AccuracyAccumulator(l)]));
  const orderRows: Graded[] = [];
  const reasons: Record<string, number> = {};
  let anchoredBefore = 0;
  let timestampedOnly = 0;

  const summaryFile = join(o.work, "ledger-index.json");
  const summaries = await loadSummaryCache(summaryFile);

  for (const chain of CHAINS) {
    const index = await chainIndex(o.store, chain, summaries);
    const c = { entries: 0, graded: 0, ungraded: 0, pending: 0 };
    counts[chain] = c;
    const consume = (rows: readonly Graded[]) => {
      for (const g of rows) {
        c[g.status]++;
        if (g.status === "ungraded")
          reasons[g.reason ?? "unknown"] = (reasons[g.reason ?? "unknown"] ?? 0) + 1;
        if (g.status === "pending") continue;
        if (g.scope === "order" && chain === "eval") orderRows.push(g);
        if (g.status !== "graded") continue;
        for (const l of LABELS) acc[l]?.add(g);
        if (g.scope === "order") {
          const a = anchors.find((w) => g.registeredAt >= w.fromMs && g.registeredAt < w.toMs);
          if (a && a.anchoredAtMs <= g.until) anchoredBefore++;
          else timestampedOnly++;
        }
      }
    };
    // final objects stream straight into the aggregates; only objects with pending forecasts are loaded
    const open: { name: string; entries: ForecastEntry[]; kept: Graded[] }[] = [];
    const toGrade: PlanEntries[] = [];
    for (const obj of index.objects) {
      c.entries += obj.count;
      let rows: Graded[] | null = null;
      try {
        rows = JSON.parse(await readFile(join(resultsDir, `${flat(obj.name)}.json`), "utf8")) as Graded[];
      } catch {}
      // a pending plan is worth loading only once its last slice is due and inside the closed tape
      const due = (g: Graded) => o.now >= g.until + DUE_AFTER_MS && g.until + MATCH_WINDOW_MS <= end;
      const duePlans = rows
        ? new Set(
            rows
              .filter((r) => r.status === "pending" && r.scope === "order" && due(r))
              .map((r) => r.planHash),
          )
        : null;
      if (rows && rows.length === obj.count && duePlans?.size === 0) {
        consume(rows);
        continue;
      }
      const entries = await loadObject(o.store, obj.name);
      const pending = duePlans ?? new Set(entries.map((e) => e.planHash));
      toGrade.push(...groupPlans(entries).filter((p) => pending.has(p.planHash)));
      open.push({ name: obj.name, entries, kept: (rows ?? []).filter((r) => !pending.has(r.planHash)) });
    }
    const graded = await gradePlans(o.source, {
      chain,
      plans: toGrade,
      context: chain === "eval" ? evalContextOf : traderContext,
      now: o.now,
      tapeEnd: end,
    });
    const byHash = new Map(graded.map((g) => [g.hash, g]));
    for (const obj of open) {
      const kept = new Map(obj.kept.map((g) => [g.hash, g]));
      const rows = obj.entries
        .map((e) => byHash.get(e.hash) ?? kept.get(e.hash))
        .filter((g): g is Graded => !!g);
      const body = JSON.stringify(rows);
      await writeFile(join(resultsDir, `${flat(obj.name)}.json`), body);
      if (o.publish !== false)
        await o.store.put(gradesName(obj.name), Buffer.from(body), {
          contentType: "application/json",
          cacheControl: "no-cache, max-age=30",
          gzip: true,
        });
      consume(rows);
    }
    log(
      `grade ${chain}: ${toGrade.length} plan(s) evaluated; ${c.graded} graded, ${c.ungraded} ungraded, ${c.pending} pending`,
    );
  }
  await saveSummaryCache(summaryFile, summaries);

  // eval orders → session and baseline venue per order, from the saved snapshot (cached per batch)
  const metaFile = join(o.work, "grade", "order-meta.json");
  let meta: Record<string, OrderMeta[]> = {};
  try {
    meta = JSON.parse(await readFile(metaFile, "utf8")) as Record<string, OrderMeta[]>;
  } catch {}
  for (const m of idx.manifests.values()) {
    if (meta[m.batchId]) continue;
    const b = await bundles.get(m);
    if (!b) continue;
    meta[m.batchId] = m.orders.flatMap((x) => {
      const snap = b.snapshots[x.symbol];
      if (x.status !== "registered" || !snap) return [];
      return [
        {
          key: `${m.batchId}:${x.i}`,
          session: sessionAt(snap.now, snap.holidays).session,
          symbol: x.symbol,
          notionalUsd: x.notionalUsd,
          primary: primaryVenue(snap),
        },
      ];
    });
  }
  await writeFile(metaFile, JSON.stringify(meta));
  const orders = Object.values(meta).flat();
  const outcomes = orderOutcomes(orderRows, orders);
  const seed = o.protocol.seed;
  const headToHead: TrackRecord["headToHead"] = {};
  const losses: LossRow[] = [];
  for (const l of LABELS) {
    const imm = compare(outcomes, "immediate", l, seed);
    const twap = compare(outcomes, "twap60", l, seed);
    headToHead[l] = { vsImmediate: imm.all, vsTwap60: twap.all };
    if (l !== "BOUND")
      losses.push(
        ...lossesOf(imm.diffs, `chosen vs immediate (${l})`, seed),
        ...lossesOf(twap.diffs, `chosen vs twap60 (${l})`, seed),
      );
  }
  const ablation = await runAblations(o, idx, bundles, orderRows, end, log);

  return {
    generatedAt: o.now,
    protocol: { name: o.protocol.name, version: o.protocol.version, hash: PROTOCOL_HASH },
    tapeEnd: end,
    primaryLabel: "REPRODUCIBLE",
    labels: LABELS,
    counts,
    ungradedReasons: reasons,
    accuracy: Object.fromEntries(LABELS.map((l) => [l, acc[l]?.rows() ?? []])),
    headToHead,
    calibration: Object.fromEntries(LABELS.map((l) => [l, calibration(orderRows, l)])),
    ablation,
    losses,
    anchoring: { anchoredBeforeOutcome: anchoredBefore, ledgerTimestampedOnly: timestampedOnly },
    notes: [
      "Costs are bps of each venue's arrival mid, fees included; positive = cost to the trader. Labels: REPRODUCIBLE = shadow fill on the recorded book (no own-impact carry-over); MODELED = carry-over decaying with the atlas resilience half-life (60 s prior where none); BOUND = no refill within the order.",
      "Slices are matched to the nearest recorded books15 snapshot within 2 s (protocol). The recorder writes books15 only when the book changes (at most 1/s), so sparse rToken ladders leave more rToken slices ungraded; such slices are reported, never imputed.",
      "books15 carries 15 levels per side: slices deeper than that are ungraded ('deeper than the recorded book levels').",
      "Passive fills: protocol v1 defines no fill rule; the grader uses the conservative trade-through rule (fills only against prints strictly through the resting price) and crosses the remainder at the end of the rest period.",
      "TWAP-60 baseline: the planner prices it only when it has at least two $5k clips, so $5k orders have no TWAP comparison.",
      "Head-to-head baselines use the planner's baseline venue per order (rToken when tradable at arrival, else perp).",
      "Calibration factors are applied only to forecasts registered after the outcomes they were fitted on (time split).",
      "Forecasts whose outcome precedes their on-chain anchor are reported as ledger-timestamped only.",
    ],
  };
}

async function anchoredWindows(
  store: ObjectStore,
): Promise<{ fromMs: number; toMs: number; anchoredAtMs: number }[]> {
  const out: { fromMs: number; toMs: number; anchoredAtMs: number }[] = [];
  for (const name of await store.list("anchors/")) {
    if (!/anchors\/\d+\.json$/.test(name)) continue;
    const got = await store.get(name);
    if (!got) continue;
    const a = JSON.parse(got.data.toString()) as { fromTs: number; toTs: number; anchoredAt?: number };
    if (a.anchoredAt)
      out.push({ fromMs: a.fromTs * 1000, toMs: a.toTs * 1000, anchoredAtMs: a.anchoredAt * 1000 });
  }
  return out;
}

interface AblationSource {
  source: string;
  chosenId: string | null;
  changed: boolean;
  registered: boolean; // chosen' is one of the order's registered (ledger) strategies
  schedule?: ScheduleSlice[]; // counterfactual schedule when it is not
  parentQty?: number;
  realized: number | null;
  predicted: number | null;
  final: boolean;
}

interface AblationOrder {
  key: string;
  symbol: string;
  baselineId: string | null;
  registeredChosen: string | null;
  sources: AblationSource[];
  chosenRealized: number | null;
  chosenPredicted: number | null;
}

const orderFinal = (x: AblationOrder) => x.sources.every((s) => s.final);

/** Planner replays are deterministic, so each batch is replayed once; later runs only fill in realized costs. */
async function replayBatch(
  o: GradeJobOptions,
  m: BatchManifest,
  b: SnapshotBundle,
): Promise<AblationOrder[]> {
  const out: AblationOrder[] = [];
  for (const x of m.orders) {
    const snap = b.snapshots[x.symbol];
    if (x.status !== "registered" || !snap) continue;
    const rep = replayAblations(
      snap,
      { symbol: x.symbol, side: x.side, notionalUsd: x.notionalUsd },
      o.protocol.profile,
    );
    const chosenId = x.roles.chosen ?? null;
    out.push({
      key: `${m.batchId}:${x.i}`,
      symbol: x.symbol,
      baselineId: rep.baseline?.id ?? null,
      registeredChosen: chosenId,
      chosenRealized: null,
      chosenPredicted: null,
      sources: rep.replays.map((r) => {
        const id = r.chosen?.id ?? null;
        const registered = x.plans.some((p) => p.strategyId === id);
        const s: AblationSource = {
          source: r.source,
          chosenId: id,
          changed: id !== chosenId,
          registered,
          realized: null,
          predicted: r.chosen?.expectedBps ?? null,
          final: false,
        };
        if (r.chosen && !registered) {
          s.schedule = scheduleFromQuote(r.chosen.slices);
          s.parentQty = r.chosen.qty;
        }
        return s;
      }),
    });
  }
  return out;
}

async function runAblations(
  o: GradeJobOptions,
  idx: EvalIndex,
  bundles: Bundles,
  orderRows: readonly Graded[], // eval order-scope rows that are final (graded or ungraded)
  end: number,
  log: (m: string) => void,
): Promise<TrackRecord["ablation"]> {
  const dir = join(o.work, "grade", "ablation");
  await mkdir(dir, { recursive: true });
  const rowsByOrder = new Map<string, Graded[]>();
  for (const g of orderRows) {
    const k = `${g.batchId}:${g.order}`;
    rowsByOrder.set(k, [...(rowsByOrder.get(k) ?? []), g]);
  }
  const all: AblationOrder[] = [];
  let batches = 0;
  for (const m of [...idx.manifests.values()].sort((a, b) => a.batchStart - b.batchStart)) {
    const file = join(dir, `${m.batchId}.json`);
    let orders: AblationOrder[] | null = null;
    try {
      orders = JSON.parse(await readFile(file, "utf8")) as AblationOrder[];
    } catch {}
    if (orders?.every(orderFinal)) {
      all.push(...orders);
      batches++;
      continue;
    }
    // replay once every order's chosen plan is final (graded or ungraded)
    const due = m.orders.every(
      (x) =>
        !x.roles.chosen ||
        (rowsByOrder.get(`${m.batchId}:${x.i}`) ?? []).some((g) => g.roles?.includes("chosen")),
    );
    if (!orders) {
      if (!due) continue;
      const b = await bundles.get(m);
      if (!b) continue;
      orders = await replayBatch(o, m, b);
      log(`ablation ${m.batchId}: replayed ${orders.length} orders × ${ABLATIONS.length} sources`);
    }
    const jobs: { s: AblationSource; symbol: string }[] = [];
    for (const x of orders) {
      const rows = rowsByOrder.get(x.key) ?? [];
      const row = (id: string | null) => rows.find((r) => r.strategyId === id);
      const realized = (g: Graded | undefined) =>
        g?.status === "graded" ? (g.realized?.REPRODUCIBLE ?? null) : null;
      x.chosenRealized = realized(row(x.registeredChosen));
      x.chosenPredicted = row(x.registeredChosen)?.p50 ?? null;
      for (const s of x.sources) {
        if (s.final) continue;
        if (!s.changed) {
          s.realized = x.chosenRealized;
          s.predicted = x.chosenPredicted;
          s.final = true;
        } else if (s.registered) {
          const g = row(s.chosenId);
          if (g) {
            s.realized = realized(g);
            s.predicted = g.p50;
            s.final = true;
          }
        } else if (!s.schedule?.length) s.final = true;
        else if (
          o.now >= lastTime(s.schedule) + DUE_AFTER_MS &&
          lastTime(s.schedule) + MATCH_WINDOW_MS <= end
        )
          jobs.push({ s, symbol: x.symbol });
      }
    }
    if (jobs.length) {
      const b = await bundles.get(m);
      const runnable = jobs.filter((j) => b?.snapshots[j.symbol]);
      const out = await realizeJobs(
        o.source,
        runnable.map((j) => ({
          symbol: j.symbol,
          parentQty: j.s.parentQty as number,
          schedule: j.s.schedule as ScheduleSlice[],
          ctx: evalContext(b?.snapshots[j.symbol] as Parameters<typeof evalContext>[0], {}),
        })),
      );
      runnable.forEach((j, k) => {
        const r = out[k] as ScheduleOutcome;
        const f = r.funding && "bps" in r.funding ? r.funding.bps : 0;
        j.s.realized =
          r.funding && "missing" in r.funding
            ? null
            : orderRealized(j.s.schedule as ScheduleSlice[], r.slices, j.s.parentQty as number, f)
                .REPRODUCIBLE;
        j.s.final = true;
      });
    }
    await writeFile(file, JSON.stringify(orders));
    all.push(...orders);
    batches++;
  }
  const sources: AblationRow[] = ABLATIONS.map((a) => {
    const xs = all.map((x) => ({ x, s: x.sources.find((s) => s.source === a.source) as AblationSource }));
    const changed = xs.filter((y) => y.s?.changed);
    const both = changed.filter((y) => y.s.final && y.s.realized !== null && y.x.chosenRealized !== null);
    const deltas = both.map((y) => (y.s.realized as number) - (y.x.chosenRealized as number));
    const errDeltas = both
      .filter((y) => y.s.predicted !== null && y.x.chosenPredicted !== null)
      .map(
        (y) =>
          Math.abs((y.s.predicted as number) - (y.s.realized as number)) -
          Math.abs((y.x.chosenPredicted as number) - (y.x.chosenRealized as number)),
      );
    const sm = deltas.length ? summarize(deltas, o.protocol.seed) : null;
    return {
      source: a.source,
      fallback: a.fallback,
      orders: xs.length,
      changed: changed.length,
      changedShare: xs.length ? changed.length / xs.length : Number.NaN,
      deltaRealizedBps: sm ? { n: sm.n, mean: sm.meanDiffBps, ci95: sm.ci95 } : null,
      deltaAbsErrorBps: errDeltas.length
        ? { n: errDeltas.length, mean: errDeltas.reduce((s, d) => s + d, 0) / errDeltas.length }
        : null,
    };
  });
  return {
    batches,
    orders: all.length,
    replayMatchesRegistered: all.filter((x) => x.baselineId === x.registeredChosen).length,
    sources,
  };
}
