// Realized cost of a schedule on the recorded tape, in bps of each venue's arrival mid, fees included.
// Three own-impact conventions (protocol "ownImpact"):
//   REPRODUCIBLE — every slice walks the matched recorded book as printed (shadow fill, no carry-over)
//   MODELED      — earlier slices' consumption carries over, decaying with the estimated resilience half-life
//   BOUND        — earlier slices' consumption never refills within the order (worst case)
// Nothing is imputed: a slice without a matched book, or deeper than the recorded levels, leaves the label null.
import { type Book, costVsMid, type Side, type Venue, walk } from "@slipway/core";

export const LABELS = ["REPRODUCIBLE", "MODELED", "BOUND"] as const;
export type Label = (typeof LABELS)[number];
export type ByLabel = Record<Label, number | null>;

export interface ScheduleSlice {
  t: number;
  venue: Venue;
  side: Side;
  qty: number;
  kind: "market" | "limit";
  restSec?: number; // limit: rest at the touch this long, then cross the unfilled remainder
}

export interface TradePrint {
  ts: number;
  px: number;
  sz: number;
  side: Side; // taker side
}

export interface SliceMatch {
  book: Book | null; // nearest recorded book at t (≤ max gap)
  crossBook?: Book | null; // limit slices: nearest book at t + rest
  trades?: TradePrint[]; // limit slices: prints in (t, t + rest]
}

export interface RealizeContext {
  arrivalMid: Partial<Record<Venue, number>>;
  fees: Record<Venue, { maker: number; taker: number }>;
  halfLifeSec: (venue: Venue, t: number) => number;
}

export interface SliceRealized {
  realized: ByLabel;
  reason?: string; // why REPRODUCIBLE is null
  filledQty?: number; // limit slices: qty filled passively under the trade-through rule
  limitPx?: number;
}

const nullLabels = (): ByLabel => ({ REPRODUCIBLE: null, MODELED: null, BOUND: null });

/**
 * Passive fill rule (the protocol does not define one; this is the conservative public-tape convention): a resting
 * limit at the touch fills only against prints strictly through its price (buy: sells below it; sell: buys above),
 * which price priority guarantees would have reached it. Prints at the limit price are not counted (queue unknown).
 */
export function tradeThroughFill(
  side: Side,
  limitPx: number,
  qty: number,
  trades: readonly TradePrint[],
): number {
  let filled = 0;
  for (const tr of trades) {
    const through =
      side === "buy" ? tr.side === "sell" && tr.px < limitPx : tr.side === "buy" && tr.px > limitPx;
    if (through) filled += tr.sz;
    if (filled >= qty) return qty;
  }
  return filled;
}

export function realizeSchedule(
  slices: readonly ScheduleSlice[],
  matches: readonly SliceMatch[],
  ctx: RealizeContext,
): SliceRealized[] {
  const past: { venue: Venue; side: Side; t: number; qty: number }[] = [];
  const offset = (venue: Venue, side: Side, t: number, label: Label): number => {
    let s = 0;
    for (const p of past) {
      if (p.venue !== venue || p.side !== side || p.t > t) continue;
      s += label === "BOUND" ? p.qty : p.qty * 2 ** (-(t - p.t) / 1000 / ctx.halfLifeSec(venue, t));
    }
    return s;
  };
  const marketCost = (book: Book, s: { venue: Venue; side: Side; qty: number }, t: number, label: Label) => {
    const arrival = ctx.arrivalMid[s.venue];
    if (arrival === undefined) return { cost: null, reason: `no arrival mid for ${s.venue}` };
    const r = walk(book, s.side, s.qty, label === "REPRODUCIBLE" ? 0 : offset(s.venue, s.side, t, label));
    if (r.exhausted) return { cost: null, reason: "deeper than the recorded book levels" };
    return { cost: costVsMid(s.side, r.avgPx, arrival) + ctx.fees[s.venue].taker * 1e4, reason: undefined };
  };

  return slices.map((s, i) => {
    const m = matches[i] as SliceMatch;
    const out: SliceRealized = { realized: nullLabels() };
    if (s.kind === "market") {
      if (!m.book) {
        out.reason = "no recorded book within the match window";
      } else {
        for (const label of LABELS) {
          const c = marketCost(m.book, s, s.t, label);
          out.realized[label] = c.cost;
          if (label === "REPRODUCIBLE" && c.reason) out.reason = c.reason;
        }
      }
      past.push({ venue: s.venue, side: s.side, t: s.t, qty: s.qty });
      return out;
    }
    // limit at the own-side touch of the matched book, then cross the remainder
    const arrival = ctx.arrivalMid[s.venue];
    const own = m.book ? (s.side === "buy" ? m.book.bids[0] : m.book.asks[0]) : undefined;
    if (!m.book || !own) {
      out.reason = "no recorded book within the match window";
      return out;
    }
    if (arrival === undefined) {
      out.reason = `no arrival mid for ${s.venue}`;
      return out;
    }
    const filled = tradeThroughFill(s.side, own.px, s.qty, m.trades ?? []);
    out.filledQty = filled;
    out.limitPx = own.px;
    const passiveCost = costVsMid(s.side, own.px, arrival) + ctx.fees[s.venue].maker * 1e4;
    const rest = s.qty - filled;
    const crossT = s.t + (s.restSec ?? 0) * 1000;
    for (const label of LABELS) {
      if (rest <= 1e-12) {
        out.realized[label] = passiveCost;
        continue;
      }
      if (!m.crossBook) {
        if (label === "REPRODUCIBLE") out.reason = "no recorded book at the crossing time";
        continue;
      }
      const c = marketCost(m.crossBook, { venue: s.venue, side: s.side, qty: rest }, crossT, label);
      if (c.cost === null) {
        if (label === "REPRODUCIBLE") out.reason = c.reason;
        continue;
      }
      out.realized[label] = (filled * passiveCost + rest * c.cost) / s.qty;
    }
    if (rest > 1e-12) past.push({ venue: s.venue, side: s.side, t: crossT, qty: rest });
    return out;
  });
}

/** Qty-weighted order cost; null for a label if any slice lacks it. */
export function orderRealized(
  slices: readonly ScheduleSlice[],
  realized: readonly SliceRealized[],
  parentQty: number,
  extraBps = 0,
): ByLabel {
  const out = nullLabels();
  for (const label of LABELS) {
    let sum = 0;
    let ok = true;
    slices.forEach((s, i) => {
      const r = realized[i]?.realized[label];
      if (r === null || r === undefined) ok = false;
      else sum += (s.qty / parentQty) * r;
    });
    out[label] = ok ? sum + extraBps : null;
  }
  return out;
}

export const HORIZONS = ["0-60s", "1-15m", "15m-6h", ">6h"] as const;
export type Horizon = (typeof HORIZONS)[number];

export function horizonBucket(sec: number): Horizon {
  if (sec <= 60) return "0-60s";
  if (sec <= 15 * 60) return "1-15m";
  if (sec <= 6 * 3600) return "15m-6h";
  return ">6h";
}
