import type { Book, Level, Side, Venue } from "./types.js";

export type RawLevel = readonly (string | number)[];

export interface BitgetBookPayload {
  instType: string; // "SPOT" | "USDT-FUTURES"
  instId: string; // "RNVDAUSDT" (rToken) | "NVDAUSDT" (perp)
  ts: number | string;
  asks: readonly RawLevel[];
  bids: readonly RawLevel[];
}

export interface WalkResult {
  filledQty: number;
  avgPx: number;
  worstPx: number;
  costBps: number; // vs mid, excluding fees; positive = paid away
  levelsConsumed: number;
  exhausted: boolean;
}

export interface Depth {
  qty: number;
  notional: number;
}

export function parseLevels(raw: readonly RawLevel[], side: "bid" | "ask"): Level[] {
  const levels: Level[] = [];
  for (const entry of raw) {
    const px = Number(entry[0]);
    const sz = Number(entry[1]);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || sz < 0) {
      throw new Error(`invalid book level ${JSON.stringify(entry)}`);
    }
    if (sz > 0) levels.push({ px, sz });
  }
  return levels.sort(side === "bid" ? (a, b) => b.px - a.px : (a, b) => a.px - b.px);
}

export function instrumentFromBitget(instType: string, instId: string): { venue: Venue; symbol: string } {
  const spot = instType === "SPOT" ? /^R([A-Z0-9.]+)USDT$/.exec(instId) : null;
  if (spot?.[1]) return { venue: "rtoken", symbol: spot[1] };
  const perp = instType === "USDT-FUTURES" ? /^([A-Z0-9.]+)USDT$/.exec(instId) : null;
  if (perp?.[1]) return { venue: "perp", symbol: perp[1] };
  throw new Error(`unsupported instType/instId ${instType}/${instId}`);
}

export function bookFromBitget(raw: BitgetBookPayload): Book {
  const { venue, symbol } = instrumentFromBitget(raw.instType, raw.instId);
  return {
    venue,
    symbol,
    ts: Number(raw.ts),
    bids: parseLevels(raw.bids, "bid"),
    asks: parseLevels(raw.asks, "ask"),
  };
}

export function bookSeries(
  rows: readonly { ts: number; asks: readonly RawLevel[]; bids: readonly RawLevel[] }[],
  venue: Venue,
  symbol: string,
): Book[] {
  return rows.map((r) => ({
    venue,
    symbol,
    ts: r.ts,
    bids: parseLevels(r.bids, "bid"),
    asks: parseLevels(r.asks, "ask"),
  }));
}

export function mid(book: Book): number {
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!bid || !ask) throw new Error(`one-sided or empty book for ${book.symbol} ${book.venue}`);
  return (bid.px + ask.px) / 2;
}

export function spreadBps(book: Book): number {
  const m = mid(book);
  return (((book.asks[0] as Level).px - (book.bids[0] as Level).px) / m) * 1e4;
}

const levelsFor = (book: Book, side: Side): Level[] => (side === "buy" ? book.asks : book.bids);

export function costVsMid(side: Side, px: number, m: number): number {
  return side === "buy" ? (px / m - 1) * 1e4 : (1 - px / m) * 1e4;
}

// Liquidity a taker on `side` can reach within ±bps of mid (buy → asks, sell → bids).
export function depthWithin(book: Book, side: Side, bps: number): Depth {
  const m = mid(book);
  const limit = side === "buy" ? m * (1 + bps / 1e4) : m * (1 - bps / 1e4);
  let qty = 0;
  let notional = 0;
  for (const l of levelsFor(book, side)) {
    if (side === "buy" ? l.px > limit : l.px < limit) break;
    qty += l.sz;
    notional += l.sz * l.px;
  }
  return { qty, notional };
}

// Consumes levels after skipping `offsetQty` (liquidity still missing from earlier own fills).
export function walk(book: Book, side: Side, qty: number, offsetQty = 0): WalkResult {
  if (!(qty >= 0) || !(offsetQty >= 0))
    throw new RangeError(`walk qty/offset must be >= 0 (${qty}, ${offsetQty})`);
  const m = mid(book);
  const levels = levelsFor(book, side);
  const tol = 1e-12 * Math.max(1, qty + offsetQty);
  let skip = offsetQty;
  let remaining = qty;
  let filled = 0;
  let notional = 0;
  let worst = Number.NaN;
  let marginal = Number.NaN;
  let consumed = 0;
  for (const l of levels) {
    let avail = l.sz;
    if (skip > 0) {
      const s = Math.min(skip, avail);
      skip -= s;
      avail -= s;
      if (avail <= tol) continue;
    }
    if (Number.isNaN(marginal)) marginal = l.px;
    if (remaining <= tol) break;
    const take = Math.min(remaining, avail);
    filled += take;
    notional += take * l.px;
    remaining -= take;
    worst = l.px;
    consumed++;
    if (remaining <= tol) break;
  }
  const exhausted = skip > tol || remaining > tol;
  const deepest = levels.at(-1)?.px ?? Number.NaN;
  const fallback = Number.isNaN(marginal) ? deepest : marginal;
  const avgPx = consumed === 1 ? worst : filled > 0 ? notional / filled : fallback;
  return {
    filledQty: filled,
    avgPx,
    worstPx: filled > 0 ? worst : avgPx,
    costBps: costVsMid(side, avgPx, m),
    levelsConsumed: consumed,
    exhausted,
  };
}

// Quantity bought/sold for `notional`; beyond visible depth the remainder converts at the deepest price.
export function qtyForNotional(book: Book, side: Side, notional: number, offsetQty = 0): number {
  if (!(notional >= 0)) throw new RangeError(`notional must be >= 0 (${notional})`);
  const levels = levelsFor(book, side);
  let skip = offsetQty;
  let remaining = notional;
  let qty = 0;
  for (const l of levels) {
    let avail = l.sz;
    if (skip > 0) {
      const s = Math.min(skip, avail);
      skip -= s;
      avail -= s;
      if (avail <= 0) continue;
    }
    const spend = Math.min(remaining, avail * l.px);
    qty += spend / l.px;
    remaining -= spend;
    if (remaining <= 0) return qty;
  }
  const deepest = levels.at(-1)?.px;
  if (deepest === undefined) throw new Error(`empty ${side === "buy" ? "ask" : "bid"} side`);
  return qty + remaining / deepest;
}

// Re-centres a (representative) book on another mid, scaling prices multiplicatively.
export function shiftBook(book: Book, newMid: number): Book {
  const f = newMid / mid(book);
  const scale = (l: Level): Level => ({ px: l.px * f, sz: l.sz });
  return { ...book, bids: book.bids.map(scale), asks: book.asks.map(scale) };
}

export function notionalUsd(book: Book, qty: number): number {
  return qty * mid(book);
}
