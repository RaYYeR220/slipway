// Grades ledger forecasts against the recorded tape (protocol "grading"): a forecast is due once its last slice
// time + 5 s has passed and the tape reaches 2 s beyond it; each slice is matched to the nearest recorded books15
// snapshot of the same instrument within 2 s, otherwise it stays ungraded (never imputed).
import {
  type Atlas,
  atlasKey,
  DEFAULT_PRIOR_HALF_LIFE_SEC,
  type ForecastEntry,
  mid,
  type Session,
  type Slice,
  sessionAt,
  type Venue,
} from "@slipway/core";
import { nearestBooks, type Probe } from "../read.js";
import type { TapeSource } from "../source.js";
import { fundingAtSettlements, tradesInWindows, type Window } from "./lookup.js";
import {
  type ByLabel,
  type Horizon,
  horizonBucket,
  orderRealized,
  type RealizeContext,
  realizeSchedule,
  type ScheduleSlice,
  type SliceMatch,
  type SliceRealized,
} from "./realize.js";

export const MATCH_WINDOW_MS = 2_000;
export const DUE_AFTER_MS = 5_000;

export interface Graded {
  chain: "eval" | "trader";
  id: string;
  hash: string;
  planHash: string;
  strategyId: string;
  family: string;
  scope: "order" | "slice";
  symbol: string;
  side: "buy" | "sell";
  venue: Venue | "mixed";
  session: Session;
  qty: number;
  at: number;
  until: number;
  registeredAt: number;
  horizon: Horizon;
  p50: number;
  p10?: number;
  p90?: number;
  status: "graded" | "ungraded" | "pending";
  reason?: string;
  realized?: ByLabel;
  bookGapMs?: number;
  filledFrac?: number;
  batchId?: string;
  order?: number;
  roles?: string[];
}

export interface PlanContext {
  arrivalMid: Partial<Record<Venue, number>>;
  fees: Record<Venue, { maker: number; taker: number }>;
  atlas: Atlas;
  funding: { nextFundingTime: number; intervalHours: number } | null;
  batchId?: string;
  order?: number;
  roles?: string[];
}

export interface PlanEntries {
  planHash: string;
  order: ForecastEntry;
  slices: { index: number; entry: ForecastEntry }[];
}

export function groupPlans(entries: readonly ForecastEntry[]): PlanEntries[] {
  const map = new Map<string, PlanEntries>();
  for (const e of entries) {
    let p = map.get(e.planHash);
    if (!p) {
      p = { planHash: e.planHash, order: e, slices: [] };
      map.set(e.planHash, p);
    }
    if (e.scope === "order") p.order = e;
    else p.slices.push({ index: Number(e.id.slice(e.id.lastIndexOf(":") + 1)), entry: e });
  }
  for (const p of map.values()) p.slices.sort((a, b) => a.index - b.index);
  return [...map.values()].filter((p) => p.order.scope === "order");
}

/** Executable schedule of a plan as committed in the ledger (passive rest time comes from the strategy id). */
export function scheduleOf(p: PlanEntries): ScheduleSlice[] {
  if (p.order.family === "passive") {
    const rest = Number(/:T(\d+)$/.exec(p.order.strategyId)?.[1] ?? Number.NaN);
    const s = p.slices[0]?.entry;
    if (!s || !Number.isFinite(rest)) return [];
    return [{ t: s.at, venue: s.venue as Venue, side: s.side, qty: s.qty, kind: "limit", restSec: rest }];
  }
  return p.slices.map(({ entry: s }) => ({
    t: s.at,
    venue: s.venue as Venue,
    side: s.side,
    qty: s.qty,
    kind: "market",
  }));
}

/** Same schedule from a priced strategy (for counterfactual grading in the ablation). */
export function scheduleFromQuote(slices: readonly Slice[]): ScheduleSlice[] {
  const out: ScheduleSlice[] = [];
  slices.forEach((s, i) => {
    if (s.conditional) return;
    if (s.type === "limit") {
      const cross = slices
        .slice(i + 1)
        .find((c) => c.conditional && c.venue === s.venue && c.side === s.side);
      out.push({
        t: s.t,
        venue: s.venue,
        side: s.side,
        qty: s.qty,
        kind: "limit",
        restSec: cross ? (cross.t - s.t) / 1000 : 0,
      });
    } else out.push({ t: s.t, venue: s.venue, side: s.side, qty: s.qty, kind: "market" });
  });
  return out;
}

export const lastTime = (schedule: readonly ScheduleSlice[]): number =>
  Math.max(...schedule.map((s) => s.t + (s.kind === "limit" ? (s.restSec ?? 0) * 1000 : 0)));

export interface ScheduleJob {
  symbol: string;
  parentQty: number;
  schedule: ScheduleSlice[];
  ctx: PlanContext;
}

export interface ScheduleOutcome {
  slices: SliceRealized[];
  gaps: (number | null)[];
  funding: { bps: number } | { missing: string } | null;
}

/** Matches every slice of every job against the tape in one streaming pass per stream and hour. */
export async function realizeJobs(
  source: TapeSource,
  jobs: readonly ScheduleJob[],
): Promise<ScheduleOutcome[]> {
  const probes: Probe[] = [];
  const windows: Window[] = [];
  const refs = jobs.map((j) =>
    j.schedule.map((s) => {
      const book = probes.push({ venue: s.venue, symbol: j.symbol, ts: s.t }) - 1;
      if (s.kind !== "limit") return { book, cross: -1, win: -1 };
      const crossAt = s.t + (s.restSec ?? 0) * 1000;
      const cross = probes.push({ venue: s.venue, symbol: j.symbol, ts: crossAt }) - 1;
      const win = windows.push({ venue: s.venue, symbol: j.symbol, from: s.t, to: crossAt }) - 1;
      return { book, cross, win };
    }),
  );
  const books = await nearestBooks(source, probes, MATCH_WINDOW_MS);
  const prints = await tradesInWindows(source, windows);
  const out: ScheduleOutcome[] = [];
  for (const [k, j] of jobs.entries()) {
    const r = refs[k] as { book: number; cross: number; win: number }[];
    const matches: SliceMatch[] = r.map((x) => ({
      book: books[x.book]?.book ?? null,
      ...(x.cross >= 0 ? { crossBook: books[x.cross]?.book ?? null, trades: prints[x.win] ?? [] } : {}),
    }));
    const ctx: RealizeContext = {
      arrivalMid: j.ctx.arrivalMid,
      fees: j.ctx.fees,
      halfLifeSec: (venue, t) => {
        const session = sessionAt(t).session;
        const h = j.ctx.atlas[atlasKey(j.symbol, venue, session)]?.resilience?.halfLifeSec;
        return h && h > 0 ? h : DEFAULT_PRIOR_HALF_LIFE_SEC;
      },
    };
    out.push({
      slices: realizeSchedule(j.schedule, matches, ctx),
      gaps: r.map((x) => books[x.book]?.gapMs ?? null),
      funding: await realizedFunding(source, j),
    });
  }
  return out;
}

async function realizedFunding(source: TapeSource, j: ScheduleJob): Promise<ScheduleOutcome["funding"]> {
  const perp = j.schedule
    .filter((s) => s.venue === "perp")
    .map((s) => ({
      t: s.t + (s.kind === "limit" ? (s.restSec ?? 0) * 1000 : 0),
      q: s.side === "buy" ? s.qty : -s.qty,
    }));
  if (perp.length < 2) return null;
  const from = Math.min(...perp.map((p) => p.t));
  const end = Math.max(...perp.map((p) => p.t));
  const f = j.ctx.funding;
  if (!f) return { missing: "funding schedule unknown" };
  const step = f.intervalHours * 3_600_000;
  let t = f.nextFundingTime;
  while (t - step > from) t -= step;
  while (t <= from) t += step;
  const settlements: { t: number; position: number }[] = [];
  const parent = j.parentQty;
  for (; t <= end; t += step) {
    const position = perp.filter((p) => p.t <= t).reduce((s, p) => s + p.q, 0);
    if (Math.abs(position) > 1e-9 * parent) settlements.push({ t, position });
  }
  if (!settlements.length) return { bps: 0 };
  const obs = await fundingAtSettlements(
    source,
    j.symbol,
    settlements.map((s) => s.t),
  );
  let bps = 0;
  for (const [i, s] of settlements.entries()) {
    const o = obs[i];
    if (!o) return { missing: `funding rate at ${new Date(s.t).toISOString()} not recorded` };
    bps += o.rate * 1e4 * (s.position / parent);
  }
  return { bps };
}

const base = (e: ForecastEntry, chain: Graded["chain"], ctx: PlanContext | null): Graded => {
  const g: Graded = {
    chain,
    id: e.id,
    hash: e.hash,
    planHash: e.planHash,
    strategyId: e.strategyId,
    family: e.family,
    scope: e.scope,
    symbol: e.symbol,
    side: e.side,
    venue: e.venue,
    session: e.session,
    qty: e.qty,
    at: e.at,
    until: e.until,
    registeredAt: e.registeredAt,
    horizon: horizonBucket(((e.scope === "order" ? e.until : e.at) - e.registeredAt) / 1000),
    p50: e.predicted.p50,
    status: "pending",
  };
  if (e.predicted.p10 !== undefined) g.p10 = e.predicted.p10;
  if (e.predicted.p90 !== undefined) g.p90 = e.predicted.p90;
  if (ctx?.batchId !== undefined) g.batchId = ctx.batchId;
  if (ctx?.order !== undefined) g.order = ctx.order;
  if (ctx?.roles) g.roles = ctx.roles;
  return g;
};

export interface GradeInput {
  chain: Graded["chain"];
  plans: readonly PlanEntries[];
  context: (p: PlanEntries) => Promise<PlanContext | { missing: string }>;
  now: number;
  tapeEnd: number;
}

/** Graded rows for every entry of the given plans (pending where not yet due or not yet covered by the tape). */
export async function gradePlans(source: TapeSource, input: GradeInput): Promise<Graded[]> {
  const rows: Graded[] = [];
  const jobs: { p: PlanEntries; schedule: ScheduleSlice[]; ctx: PlanContext }[] = [];
  for (const p of input.plans) {
    const schedule = scheduleOf(p);
    const ctx = await input.context(p);
    const entries = [p.order, ...p.slices.map((s) => s.entry)];
    const emit = (status: Graded["status"], reason?: string) => {
      for (const e of entries) {
        const g = base(e, input.chain, "missing" in ctx ? null : ctx);
        g.status = status;
        if (reason) g.reason = reason;
        rows.push(g);
      }
    };
    if (schedule.length === 0) {
      emit("ungraded", "plan schedule not reconstructible from the ledger");
      continue;
    }
    const last = lastTime(schedule);
    if (input.now < last + DUE_AFTER_MS || last + MATCH_WINDOW_MS > input.tapeEnd) {
      emit("pending");
      continue;
    }
    if ("missing" in ctx) {
      emit("ungraded", ctx.missing);
      continue;
    }
    if (p.order.family === "perp_hold") {
      emit("ungraded", "perp hold horizon is not recorded in the ledger");
      continue;
    }
    jobs.push({ p, schedule, ctx });
  }
  const outcomes = await realizeJobs(
    source,
    jobs.map((j) => ({
      symbol: j.p.order.symbol,
      parentQty: j.p.order.qty,
      schedule: j.schedule,
      ctx: j.ctx,
    })),
  );
  jobs.forEach((j, k) => {
    const o = outcomes[k] as ScheduleOutcome;
    const order = base(j.p.order, input.chain, j.ctx);
    const fundingMissing = o.funding && "missing" in o.funding ? o.funding.missing : null;
    const realized = orderRealized(
      j.schedule,
      o.slices,
      j.p.order.qty,
      o.funding && "bps" in o.funding ? o.funding.bps : 0,
    );
    if (fundingMissing) {
      order.status = "ungraded";
      order.reason = fundingMissing;
    } else if (realized.REPRODUCIBLE === null) {
      order.status = "ungraded";
      order.reason = o.slices.find((s) => s.reason)?.reason ?? "a slice could not be graded";
    } else order.status = "graded";
    order.realized = realized;
    const limit = j.schedule[0]?.kind === "limit" ? o.slices[0] : undefined;
    if (limit?.filledQty !== undefined)
      order.filledFrac = limit.filledQty / (j.schedule[0] as ScheduleSlice).qty;
    rows.push(order);
    j.p.slices.forEach(({ entry }, i) => {
      const g = base(entry, input.chain, j.ctx);
      const s = o.slices[i] as SliceRealized | undefined;
      const gap = o.gaps[i];
      if (gap !== null && gap !== undefined) g.bookGapMs = gap;
      if (j.schedule[i]?.kind === "limit") {
        // the slice forecast is the passive fill; it is graded only when the tape shows a full fill
        const full =
          s?.filledQty !== undefined && s.filledQty >= (j.schedule[i] as ScheduleSlice).qty - 1e-12;
        g.status = full ? "graded" : "ungraded";
        if (full) g.realized = s.realized;
        else g.reason = s?.reason ?? "passive slice not fully filled under the trade-through rule";
        if (s?.filledQty !== undefined) g.filledFrac = s.filledQty / (j.schedule[i] as ScheduleSlice).qty;
      } else if (s && s.realized.REPRODUCIBLE !== null) {
        g.status = "graded";
        g.realized = s.realized;
      } else {
        g.status = "ungraded";
        g.reason = s?.reason ?? "slice not matched";
      }
      rows.push(g);
    });
  });
  return rows;
}

/** Arrival mids, fees and atlas of an eval plan from the batch's saved snapshot. */
export function evalContext(
  snap: {
    books: Partial<Record<Venue, { bids: { px: number }[]; asks: { px: number }[] } & object>>;
    fees: Record<Venue, { maker: number; taker: number }>;
    atlas: Atlas;
    funding: { nextFundingTime: number; intervalHours: number } | null;
  },
  extra: Pick<PlanContext, "batchId" | "order" | "roles">,
): PlanContext {
  const arrivalMid: Partial<Record<Venue, number>> = {};
  for (const v of ["rtoken", "perp"] as const) {
    const b = snap.books[v];
    if (b?.bids[0] && b.asks[0]) arrivalMid[v] = mid(b as Parameters<typeof mid>[0]);
  }
  return { arrivalMid, fees: snap.fees, atlas: snap.atlas, funding: snap.funding, ...extra };
}
