// Lossless-for-purpose book compaction for the atlas. Liquidity stats only read the touch (mid, spread, touch
// hits) and the notional inside ±10/25/50 bps of mid (depth bands, resilience). A compact book keeps the touch
// level exactly and folds the remaining levels of each band into one level at the band's VWAP with the band's
// total size, so mid, spread and depthWithin(…, 10|25|50) are unchanged while a 1 s book series fits in memory.
// Compact books never leave this module's callers: the published representative book is always a real one.
import { type Book, type Level, mid, type Side } from "@slipway/core";

export const BANDS_BPS = [10, 25, 50] as const;

export type PackedLevel = [number, number];
export interface PackedBook {
  t: number;
  b: PackedLevel[];
  a: PackedLevel[];
}

function compactSide(levels: readonly Level[], side: Side, m: number): PackedLevel[] {
  const best = levels[0];
  if (!best) return [];
  const out: PackedLevel[] = [[best.px, best.sz]];
  const limits = BANDS_BPS.map((bps) => (side === "buy" ? m * (1 + bps / 1e4) : m * (1 - bps / 1e4)));
  let k = 1;
  for (const limit of limits) {
    let qty = 0;
    let notional = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (; k < levels.length; k++) {
      const l = levels[k] as Level;
      if (side === "buy" ? l.px > limit : l.px < limit) break;
      qty += l.sz;
      notional += l.px * l.sz;
      lo = Math.min(lo, l.px);
      hi = Math.max(hi, l.px);
    }
    if (qty > 0) out.push([Math.min(hi, Math.max(lo, notional / qty)), qty]);
  }
  return out;
}

export function packBook(book: Book): PackedBook {
  const m = mid(book);
  return { t: book.ts, b: compactSide(book.bids, "sell", m), a: compactSide(book.asks, "buy", m) };
}

export const unpackBook = (p: PackedBook, venue: Book["venue"], symbol: string): Book => ({
  venue,
  symbol,
  ts: p.t,
  bids: p.b.map(([px, sz]) => ({ px, sz })),
  asks: p.a.map(([px, sz]) => ({ px, sz })),
});

export const twoSided = (b: Book): boolean => b.bids.length > 0 && b.asks.length > 0;
