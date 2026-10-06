// Indicators we recompute ourselves from raw bars instead of trusting a third-party value.
import type { Candle } from "./types.js";

export interface Bollinger {
  middle: number;
  upper: number;
  lower: number;
  bandwidth: number; // (upper - lower) / middle
  pctB: number; // (last - lower) / (upper - lower)
}

/** Bollinger bands over the last `period` closes; `ddof` 1 = sample stdev (pandas default), 0 = population. */
export function bollinger(closes: number[], period = 20, k = 2, ddof: 0 | 1 = 1): Bollinger {
  if (closes.length < period || period < 2)
    throw new RangeError(`bollinger needs ${period} closes, got ${closes.length}`);
  const w = closes.slice(-period);
  const middle = w.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - middle) ** 2, 0) / (period - ddof));
  const upper = middle + k * sd;
  const lower = middle - k * sd;
  const last = w[w.length - 1] as number;
  return {
    middle,
    upper,
    lower,
    bandwidth: (upper - lower) / middle,
    pctB: upper === lower ? 0.5 : (last - lower) / (upper - lower),
  };
}

/** Wilder RSI over all closes (seeded with a simple average of the first `period` changes). */
export function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) throw new RangeError(`rsi needs > ${period} closes, got ${closes.length}`);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder ATR. */
export function atr(bars: Pick<Candle, "high" | "low" | "close">[], period = 14): number {
  if (bars.length <= period) throw new RangeError(`atr needs > ${period} bars, got ${bars.length}`);
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i] as Candle;
    const prev = (bars[i - 1] as Candle).close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)));
  }
  let v = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) v = (v * (period - 1) + (tr[i] as number)) / period;
  return v;
}
