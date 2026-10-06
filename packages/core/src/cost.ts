import { costVsMid, mid, shiftBook, walk } from "./book.js";
import { sessionAt, transitions, venueTradable } from "./session.js";
import { poissonTail, Z90 } from "./stats.js";
import {
  atlasKey,
  type Book,
  type CostComponents,
  type Fees,
  type MarketSnapshot,
  type Session,
  type Side,
  type Slice,
  type Venue,
} from "./types.js";

export interface PlannedSlice {
  t: number;
  venue: Venue;
  side: Side;
  qty: number;
  mode: "market" | "passive";
  restSec?: number; // passive: rest at the touch this long, then cross the remainder
}

export interface Schedule {
  parentQty: number;
  entry: PlannedSlice[]; // slices that acquire the parent exposure
  rotation?: { out: PlannedSlice[]; in: PlannedSlice[] }; // perp unwind + rToken purchase, exposure-neutral
  perpHoldUntil?: number; // perp_hold: funding accrues until here
}

export interface CostOptions {
  fees?: Record<Venue, Fees>;
  priorHalfLifeSec?: number;
}

export interface CostEstimate {
  expectedBps: number;
  sdBps: number;
  p10Bps: number; // expected ∓ 1.2816·sd, normal approximation
  p90Bps: number;
  components: CostComponents & { priceRisk: number };
  slices: Slice[];
  exhausted: boolean;
  assumptions: string[];
}

export type PriceResult = { ok: true; estimate: CostEstimate } | { ok: false; reason: string };

export const DEFAULT_PRIOR_HALF_LIFE_SEC = 60;
const HOUR_MS = 3_600_000;

class Unpriceable extends Error {}

type Leg = NonNullable<Slice["leg"]>;

interface Fill {
  t: number;
  qty: number;
}

export function priceSchedule(
  schedule: Schedule,
  snap: MarketSnapshot,
  options: CostOptions = {},
): PriceResult {
  try {
    return { ok: true, estimate: price(schedule, snap, options) };
  } catch (e) {
    if (e instanceof Unpriceable) return { ok: false, reason: e.message };
    throw e;
  }
}

function price(schedule: Schedule, snap: MarketSnapshot, options: CostOptions): CostEstimate {
  const Q = schedule.parentQty;
  if (!(Q > 0) || schedule.entry.length === 0) throw new Unpriceable("empty schedule");
  const fees = options.fees ?? snap.fees;
  const prior = options.priorHalfLifeSec ?? DEFAULT_PRIOR_HALF_LIFE_SEC;
  const assumptions = new Set<string>();
  const nowSession = sessionAt(snap.now, snap.holidays).session;
  const sessionOf = (t: number): Session => sessionAt(t, snap.holidays).session;

  const arrival = (venue: Venue): number => {
    const live = snap.books[venue];
    if (!live) throw new Unpriceable(`no live ${venue} book to anchor prices`);
    return mid(live);
  };

  const bookCache = new Map<string, Book>();
  const bookAt = (venue: Venue, t: number): Book => {
    const session = sessionOf(t);
    const live = snap.books[venue];
    const sameSpan = t <= snap.now || transitions(snap.now, t, snap.holidays).length <= 1;
    if (live && session === nowSession && sameSpan) return live;
    const key = `${venue}|${session}`;
    const cached = bookCache.get(key);
    if (cached) return cached;
    const rep = snap.atlas[atlasKey(snap.symbol, venue, session)]?.representativeBook;
    if (!rep) throw new Unpriceable(`no representative ${venue} book for ${session}`);
    const shifted = shiftBook(rep, arrival(venue));
    bookCache.set(key, shifted);
    return shifted;
  };

  const halfLife = (venue: Venue, session: Session): number => {
    const r = snap.atlas[atlasKey(snap.symbol, venue, session)]?.resilience;
    if (r && r.halfLifeSec > 0) return r.halfLifeSec;
    assumptions.add(`no measured depth half-life for ${venue}/${session}; prior ${prior}s used`);
    return prior;
  };

  // Liquidity our earlier fills removed and the book has not yet replenished (per venue × book side).
  const fills = new Map<string, Fill[]>();
  const residual = (venue: Venue, side: Side, t: number, session: Session): number => {
    const past = fills.get(`${venue}|${side}`) ?? [];
    if (past.length === 0) return 0;
    const h = halfLife(venue, session);
    return past.reduce((s, f) => s + f.qty * 2 ** (-(t - f.t) / 1000 / h), 0);
  };
  const consume = (venue: Venue, side: Side, t: number, qty: number) => {
    const key = `${venue}|${side}`;
    fills.set(key, [...(fills.get(key) ?? []), { t, qty }]);
  };

  let spread = 0;
  let impact = 0;
  let feeBps = 0;
  let nonFillVar = 0;
  let exhausted = false;
  const slices: Slice[] = [];

  const legs: { s: PlannedSlice; leg: Leg; order: number }[] = [
    ...schedule.entry.map((s) => ({ s, leg: "entry" as const })),
    ...(schedule.rotation?.out ?? []).map((s) => ({ s, leg: "rotate_out" as const })),
    ...(schedule.rotation?.in ?? []).map((s) => ({ s, leg: "rotate_in" as const })),
  ]
    .map((x, order) => ({ ...x, order }))
    .sort((a, b) => a.s.t - b.s.t || a.order - b.order);

  for (const { s, leg } of legs) {
    if (!(s.qty > 0)) throw new Unpriceable(`non-positive slice qty at ${s.t}`);
    const w = s.qty / Q;
    const taker = fees[s.venue].taker * 1e4;
    const marketAt = (t: number) => {
      const session = sessionOf(t);
      const book = bookAt(s.venue, t);
      const r = walk(book, s.side, s.qty, residual(s.venue, s.side, t, session));
      const touch = (s.side === "buy" ? book.asks[0] : book.bids[0])?.px ?? r.avgPx;
      const half = costVsMid(s.side, touch, mid(book));
      exhausted ||= r.exhausted;
      return { session, cost: r.costBps + taker, half, impact: r.costBps - half };
    };

    if (s.mode === "market") {
      const m = marketAt(s.t);
      spread += w * m.half;
      impact += w * m.impact;
      feeBps += w * taker;
      consume(s.venue, s.side, s.t, s.qty);
      slices.push({
        t: s.t,
        venue: s.venue,
        side: s.side,
        qty: s.qty,
        type: "market",
        session: m.session,
        expectedBps: m.cost,
        leg,
      });
      continue;
    }

    const rest = s.restSec ?? 0;
    const session = sessionOf(s.t);
    const book = bookAt(s.venue, s.t);
    const own = (s.side === "buy" ? book.bids[0] : book.asks[0]) as { px: number; sz: number };
    const stats = snap.atlas[atlasKey(snap.symbol, s.venue, session)];
    let p = 0;
    if (stats && stats.touchHitRatePerMin > 0 && stats.medianTradeQty > 0) {
      // fills arrive as Poisson touch hits of median size; we sit behind the displayed queue
      p = poissonTail((own.sz + s.qty) / stats.medianTradeQty, (stats.touchHitRatePerMin * rest) / 60);
    } else {
      assumptions.add(`no touch-hit flow recorded for ${s.venue}/${session}; passive fill probability 0`);
    }
    const maker = fees[s.venue].maker * 1e4;
    const ownHalf = costVsMid(s.side, own.px, mid(book));
    const filled = ownHalf + maker;
    const crossAt = s.t + rest * 1000;
    const c = marketAt(crossAt);
    spread += w * (p * ownHalf + (1 - p) * c.half);
    impact += w * (1 - p) * c.impact;
    feeBps += w * (p * maker + (1 - p) * taker);
    nonFillVar += w * w * p * (1 - p) * (c.cost - filled) ** 2;
    if (p < 1) consume(s.venue, s.side, crossAt, s.qty * (1 - p));
    slices.push(
      {
        t: s.t,
        venue: s.venue,
        side: s.side,
        qty: s.qty,
        type: "limit",
        limitPx: own.px,
        postOnly: true,
        session,
        expectedBps: filled,
        leg,
      },
      {
        t: crossAt,
        venue: s.venue,
        side: s.side,
        qty: s.qty,
        type: "market",
        session: c.session,
        expectedBps: c.cost,
        conditional: true,
        leg,
      },
    );
  }
  if (nonFillVar > 0)
    assumptions.add("passive fill is all-or-nothing and independent of price drift (no adverse selection)");

  const risk = executionRisk(schedule, snap, sessionOf, assumptions);
  const funding = fundingBps(schedule, snap, assumptions);
  let basisVar = 0;
  if (schedule.rotation) {
    const sigmaB = snap.basisSigmaBpsPerSqrtHour;
    if (!(sigmaB !== undefined && Number.isFinite(sigmaB)))
      throw new Unpriceable("basis sigma unavailable for rotation");
    const firstEntry = Math.min(...schedule.entry.map(execTime));
    const rotateAt = Math.min(...[...schedule.rotation.out, ...schedule.rotation.in].map((s) => s.t));
    basisVar = sigmaB ** 2 * Math.max(0, (rotateAt - firstEntry) / HOUR_MS);
    assumptions.add("expected perp/rToken basis change is zero; cross-venue impact ignored");
  }

  const expectedBps = spread + impact + feeBps + funding;
  const sdBps = Math.sqrt(risk.priceVar + risk.gapVar + basisVar + nonFillVar);
  return {
    expectedBps,
    sdBps,
    p10Bps: expectedBps - Z90 * sdBps,
    p90Bps: expectedBps + Z90 * sdBps,
    components: {
      spread,
      impact,
      fees: feeBps,
      funding,
      gapRisk: Math.sqrt(risk.gapVar),
      basisRisk: Math.sqrt(basisVar),
      nonFill: Math.sqrt(nonFillVar),
      priceRisk: Math.sqrt(risk.priceVar),
    },
    slices,
    exhausted,
    assumptions: [...assumptions],
  };
}

const execTime = (s: PlannedSlice): number => (s.mode === "passive" ? s.t + (s.restSec ?? 0) * 1000 : s.t);

// ∫σ²dt over [from, to] for a venue, session by session; closed or unmeasured spans use the largest σ on record.
function integratedVariance(
  venue: Venue,
  from: number,
  to: number,
  snap: MarketSnapshot,
  assumptions: Set<string>,
): number {
  if (!(to > from)) return 0;
  let v = 0;
  for (const span of transitions(from, to, snap.holidays)) {
    // Price risk belongs to the underlying, not to one venue's quote: rToken ladders are re-quoted every
    // ~14 s and understate σ over short windows, so use the larger σ of the venues trading in this session.
    const sigmas = (["rtoken", "perp"] as const)
      .filter((v) => venueTradable(v, span.session, snap.sessions))
      .map((v) => snap.atlas[atlasKey(snap.symbol, v, span.session)]?.sigmaBpsPerSqrtSec)
      .filter((x): x is number => x !== undefined && Number.isFinite(x) && x > 0);
    const tradable = venueTradable(venue, span.session, snap.sessions);
    let s = tradable && sigmas.length > 0 ? Math.max(...sigmas) : Number.NaN;
    if (Number.isNaN(s)) {
      s = fallbackSigma(snap);
      assumptions.add(
        `no σ for ${venue}/${span.session}; used the largest recorded σ ${s.toFixed(3)} bps/√s`,
      );
    }
    v += s * s * ((span.end - span.start) / 1000);
  }
  return v;
}

function fallbackSigma(snap: MarketSnapshot): number {
  const sigmas = Object.values(snap.atlas)
    .filter((s) => s.symbol === snap.symbol)
    .map((s) => s.sigmaBpsPerSqrtSec)
    .filter((s) => Number.isFinite(s) && s > 0);
  if (sigmas.length === 0) throw new Unpriceable(`no volatility estimate for ${snap.symbol}`);
  return Math.max(...sigmas);
}

function executionRisk(
  schedule: Schedule,
  snap: MarketSnapshot,
  sessionOf: (t: number) => Session,
  assumptions: Set<string>,
): { priceVar: number; gapVar: number } {
  const Q = schedule.parentQty;
  const entry = [...schedule.entry].sort((a, b) => execTime(a) - execTime(b));
  const start = Math.min(...schedule.entry.map((s) => s.t));
  const first = entry[0] as PlannedSlice;
  let gapVar = 0;
  if (start > snap.now) {
    const key = `${first.venue}|${sessionOf(snap.now)}->${sessionOf(start)}`;
    const gap = snap.gapSigmaBps?.[key];
    if (gap !== undefined && Number.isFinite(gap)) gapVar = gap * gap;
    else {
      gapVar = integratedVariance(first.venue, snap.now, start, snap, assumptions);
      assumptions.add(`gap σ for ${key} unavailable; wait priced with integrated session σ`);
    }
  }
  let priceVar = 0;
  let remaining = Q;
  let cursor = start;
  for (const s of entry) {
    const t = execTime(s);
    priceVar += integratedVariance(s.venue, cursor, t, snap, assumptions) * (remaining / Q) ** 2;
    remaining -= s.qty;
    cursor = Math.max(cursor, t);
  }
  return { priceVar, gapVar };
}

function fundingBps(schedule: Schedule, snap: MarketSnapshot, assumptions: Set<string>): number {
  const perp = [...schedule.entry, ...(schedule.rotation?.out ?? [])]
    .filter((s) => s.venue === "perp")
    .map((s) => ({ t: execTime(s), q: s.side === "buy" ? s.qty : -s.qty }));
  if (perp.length === 0) return 0;
  const from = Math.min(...perp.map((p) => p.t));
  const end = Math.max(schedule.perpHoldUntil ?? 0, ...perp.map((p) => p.t));
  if (!(end > from)) return 0;
  const f = snap.funding;
  if (!f) throw new Unpriceable("funding unavailable for a perp position held over time");
  const step = f.intervalHours * HOUR_MS;
  let t = f.nextFundingTime;
  if (t <= snap.now) t += Math.ceil((snap.now - t + 1) / step) * step;
  let bps = 0;
  let settlements = 0;
  for (; t <= end; t += step) {
    const position = perp.filter((p) => p.t <= t).reduce((s, p) => s + p.q, 0);
    if (Math.abs(position) <= 1e-9 * schedule.parentQty) continue; // fully unwound, up to float residue
    bps += f.rate * 1e4 * (position / schedule.parentQty);
    settlements++;
  }
  if (settlements > 0)
    assumptions.add(`funding: current rate ${f.rate} assumed for ${settlements} settlement(s)`);
  return bps;
}
