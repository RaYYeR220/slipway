import { depthWithin } from "./book.js";
import { lag1Autocorrelation, median, quantile } from "./stats.js";
import type { Book, Resilience, Side } from "./types.js";

export interface TapeTrade {
  ts: number;
  px: number;
  sz: number;
  side: Side; // taker side: buy lifts asks, sell hits bids
}

export interface TapeFrame {
  ts: number;
  book: Book;
  trades: TapeTrade[]; // prints in (previous frame ts, ts]
}

export interface DepletionEvent {
  ts: number;
  side: "bid" | "ask";
  before: number;
  after: number;
  dropFrac: number;
  tradeNotional: number;
  recoverySec: number | null; // null = not recovered within censorSec
  censored: boolean;
}

export interface ResilienceOptions {
  bandBps: number;
  minDrop: number;
  recoverFrac: number;
  censorSec: number;
  minEvents: number;
  minTradeShare: number; // same-side traded notional / depth drop required to count an event
  minPersistence: number;
  maxGapSec: number; // snapshot gaps longer than this break the series
}

export const RESILIENCE_DEFAULTS: ResilienceOptions = {
  bandBps: 25,
  minDrop: 0.3,
  recoverFrac: 0.5,
  censorSec: 120,
  minEvents: 5,
  minTradeShare: 0,
  minPersistence: 0.2,
  maxGapSec: 10,
};

export function framesFromTape(books: readonly Book[], trades: readonly TapeTrade[]): TapeFrame[] {
  const sortedTrades = [...trades].sort((a, b) => a.ts - b.ts);
  const sortedBooks = [...books].sort((a, b) => a.ts - b.ts);
  let j = 0;
  return sortedBooks.map((book, i) => {
    const lo = i === 0 ? Number.NEGATIVE_INFINITY : (sortedBooks[i - 1] as Book).ts;
    while (j < sortedTrades.length && (sortedTrades[j] as TapeTrade).ts <= lo) j++;
    const bucket: TapeTrade[] = [];
    while (j < sortedTrades.length && (sortedTrades[j] as TapeTrade).ts <= book.ts)
      bucket.push(sortedTrades[j++] as TapeTrade);
    return { ts: book.ts, book, trades: bucket };
  });
}

const depthSeries = (frames: readonly TapeFrame[], side: "bid" | "ask", bandBps: number) =>
  frames.map((f) => depthWithin(f.book, side === "ask" ? "buy" : "sell", bandBps).notional);

export function depletionEvents(
  frames: readonly TapeFrame[],
  options: Partial<ResilienceOptions> = {},
): DepletionEvent[] {
  const o = { ...RESILIENCE_DEFAULTS, ...options };
  const events: DepletionEvent[] = [];
  const gapMs = o.maxGapSec * 1000;
  for (const side of ["ask", "bid"] as const) {
    const d = depthSeries(frames, side, o.bandBps);
    const takerSide: Side = side === "ask" ? "buy" : "sell";
    for (let i = 1; i < frames.length; i++) {
      const f = frames[i] as TapeFrame;
      if (f.ts - (frames[i - 1] as TapeFrame).ts > gapMs) continue;
      const before = d[i - 1] as number;
      const after = d[i] as number;
      if (!(before > 0) || (before - after) / before < o.minDrop) continue;
      const tradeNotional = f.trades.filter((t) => t.side === takerSide).reduce((s, t) => s + t.px * t.sz, 0);
      if (!(tradeNotional > 0) || tradeNotional < o.minTradeShare * (before - after)) continue;
      const target = after + o.recoverFrac * (before - after);
      let outcome: { recoverySec: number | null; censored: boolean } | null = null;
      for (let k = i + 1; k < frames.length; k++) {
        const fk = frames[k] as TapeFrame;
        if (fk.ts - (frames[k - 1] as TapeFrame).ts > gapMs) break;
        const elapsed = (fk.ts - f.ts) / 1000;
        if (elapsed > o.censorSec) {
          outcome = { recoverySec: null, censored: true };
          break;
        }
        if ((d[k] as number) >= target) {
          outcome = { recoverySec: elapsed, censored: false };
          break;
        }
      }
      // events whose follow-up ends (data end or gap) before recovery or censoring are dropped, not imputed
      if (!outcome) continue;
      events.push({
        ts: f.ts,
        side,
        before,
        after,
        dropFrac: (before - after) / before,
        tradeNotional,
        ...outcome,
      });
    }
  }
  return events.sort((a, b) => a.ts - b.ts || a.side.localeCompare(b.side));
}

// Mean lag-1 autocorrelation of log depth over both sides: a half-life only exists if depth has memory.
export function depthPersistence(
  frames: readonly TapeFrame[],
  options: Partial<ResilienceOptions> = {},
): number {
  const o = { ...RESILIENCE_DEFAULTS, ...options };
  const rho = (["ask", "bid"] as const)
    .map((side) => lag1Autocorrelation(depthSeries(frames, side, o.bandBps).map((x) => Math.log1p(x))))
    .filter((r) => Number.isFinite(r));
  return rho.length ? rho.reduce((s, r) => s + r, 0) / rho.length : Number.NaN;
}

export function estimateResilience(
  frames: readonly TapeFrame[],
  options: Partial<ResilienceOptions> = {},
): Resilience | null {
  const o = { ...RESILIENCE_DEFAULTS, ...options };
  const events = depletionEvents(frames, o);
  if (events.length < o.minEvents) return null;
  const persistence = depthPersistence(frames, o);
  if (!(persistence >= o.minPersistence)) return null;
  const times = events.map((e) => e.recoverySec ?? o.censorSec);
  return {
    halfLifeSec: median(times),
    lo: quantile(times, 0.25),
    hi: quantile(times, 0.75),
    n: events.length,
    censored: events.filter((e) => e.censored).length,
    persistence,
  };
}
