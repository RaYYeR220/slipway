// MarketEvent windows are centred: the gate avoids [ts - windowSec, ts + windowSec] (core/constraints.ts).

/** Encodes the closed interval [start, end] (ms) as a centred MarketEvent window. */
export function avoidWindow(start: number, end: number): { ts: number; windowSec: number } {
  return { ts: Math.round((start + end) / 2), windowSec: Math.round((end - start) / 2000) };
}

export const windowStart = (e: { ts: number; windowSec: number }): number => e.ts - e.windowSec * 1000;
export const windowEnd = (e: { ts: number; windowSec: number }): number => e.ts + e.windowSec * 1000;
