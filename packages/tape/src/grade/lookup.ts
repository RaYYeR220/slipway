// Batched tape lookups for grading: prints in time windows and funding rates at settlement times.
import type { Venue } from "@slipway/core";
import { hourLines } from "../read.js";
import { instId, lineFor, type TickerRecord, type TradeRecord } from "../records.js";
import { HOUR_MS, hourKey, type TapeSource } from "../source.js";
import type { TradePrint } from "./realize.js";

export interface Window {
  venue: Venue;
  symbol: string;
  from: number; // exclusive
  to: number; // inclusive
}

const hoursOf = (from: number, to: number): string[] => {
  const out: string[] = [];
  for (let t = Math.floor(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) out.push(hourKey(t));
  return out;
};

/** Public prints of each window's instrument with from < ts ≤ to. */
export async function tradesInWindows(
  source: TapeSource,
  windows: readonly Window[],
): Promise<TradePrint[][]> {
  const out: TradePrint[][] = windows.map(() => []);
  if (windows.length === 0) return out;
  const hours = new Set(windows.flatMap((w) => hoursOf(w.from, w.to)));
  const available = new Set(await source.hours("trades"));
  const needles = [...new Set(windows.map((w) => lineFor(w.venue, w.symbol)))];
  for (const hour of [...hours].sort()) {
    if (!available.has(hour)) continue;
    for await (const line of hourLines(source, "trades", hour)) {
      if (!needles.some((n) => line.includes(n))) continue;
      let r: TradeRecord;
      try {
        r = JSON.parse(line) as TradeRecord;
      } catch {
        continue;
      }
      windows.forEach((w, i) => {
        if (r.instId === instId(w.venue, w.symbol) && r.ts > w.from && r.ts <= w.to)
          (out[i] as TradePrint[]).push({ ts: r.ts, px: Number(r.px), sz: Number(r.sz), side: r.side });
      });
    }
  }
  for (const xs of out) xs.sort((a, b) => a.ts - b.ts);
  return out;
}

export interface FundingObservation {
  settlement: number;
  rate: number;
  observedAt: number;
}

/**
 * Funding rate applied at each settlement time, as the last perp ticker the recorder saw that announced that
 * settlement (nextFunding = settlement) within `maxAgeMs` before it. Missing → null (never assumed).
 */
export async function fundingAtSettlements(
  source: TapeSource,
  symbol: string,
  settlements: readonly number[],
  maxAgeMs = 15 * 60_000,
): Promise<(FundingObservation | null)[]> {
  const best: (FundingObservation | null)[] = settlements.map(() => null);
  if (settlements.length === 0) return best;
  const hours = new Set(settlements.flatMap((s) => hoursOf(s - maxAgeMs, s)));
  const available = new Set(await source.hours("tickers"));
  const needle = lineFor("perp", symbol);
  for (const hour of [...hours].sort()) {
    if (!available.has(hour)) continue;
    for await (const line of hourLines(source, "tickers", hour)) {
      if (!line.includes(needle)) continue;
      let r: TickerRecord;
      try {
        r = JSON.parse(line) as TickerRecord;
      } catch {
        continue;
      }
      const next = Number(r.nextFunding);
      settlements.forEach((s, i) => {
        if (next !== s || r.ts > s || r.ts < s - maxAgeMs) return;
        const cur = best[i];
        if (!cur || r.ts > cur.observedAt)
          best[i] = { settlement: s, rate: Number(r.funding), observedAt: r.ts };
      });
    }
  }
  return best;
}
