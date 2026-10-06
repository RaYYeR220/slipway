// 1 h candle history per venue (Bitget history-candles, ~60 days) → overnight/weekend gap σ and perp/rToken basis σ.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BitgetRest, Candle } from "@slipway/bitget";
import {
  type HolidayClosure,
  nextSessionStart,
  robustRms,
  type Session,
  type SymbolSessions,
  transitions,
  type Venue,
  venueTradable,
} from "@slipway/core";

const H = 3_600_000;
const DAY = 24 * H;

export interface CandleOptions {
  days: number;
  cacheDir?: string;
  now: number;
}

/** Completed 1 h bars over the last `days`, oldest first; cached on disk and extended incrementally. */
export async function hourlyCandles(
  rest: BitgetRest,
  venue: Venue,
  symbol: string,
  o: CandleOptions,
): Promise<Candle[]> {
  const file = o.cacheDir ? join(o.cacheDir, `${venue}-${symbol}-1h.json`) : null;
  let cached: Candle[] = [];
  if (file) {
    try {
      cached = JSON.parse(await readFile(file, "utf8")) as Candle[];
    } catch {}
  }
  const since = o.now - o.days * DAY;
  const lastComplete = Math.floor(o.now / H) * H - H; // open time of the newest completed bar
  const have = new Map(cached.filter((c) => c.ts >= since).map((c) => [c.ts, c]));
  const newest = Math.max(since - H, ...have.keys());
  let end = o.now;
  // page backwards until the cache (or the window start) is reached
  while (end > newest + H) {
    const page = (
      await rest.candles(venue, symbol, { interval: "1h", history: true, endTime: end, limit: 200 })
    ).data;
    if (page.length === 0) break;
    for (const c of page) if (c.ts >= since && c.ts <= lastComplete) have.set(c.ts, c);
    const oldest = (page[0] as Candle).ts;
    if (oldest >= end) break;
    end = oldest - 1;
    if (oldest <= since) break;
  }
  const out = [...have.values()].sort((a, b) => a.ts - b.ts);
  if (file && o.cacheDir) {
    await mkdir(o.cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(out));
  }
  return out;
}

const SESSIONS: Session[] = ["pre_market", "regular", "after_hours", "overnight", "weekend"];

export interface GapOptions {
  regularOpenSkipMin: number; // the planner waits until regular open + this
  maxWaitHours: number;
  minSamples: number;
}

export const GAP_DEFAULTS: GapOptions = { regularOpenSkipMin: 15, maxWaitHours: 72, minSamples: 8 };

export interface GapEstimate {
  sigmaBps: number;
  n: number;
}

/**
 * σ (bps) of the log return from the middle of a `from` session to the planner's entry time in the next `to`
 * session (regular: open + 15 min), from 1 h closes: start = close of the last bar completed by the midpoint,
 * end = close of the first bar completing at or after the target. A trader's "now" is uniform within the session,
 * and variance is linear in time, so the midpoint gives the expected variance of the wait.
 */
export function gapSigmas(
  candles: readonly Candle[],
  holidays: readonly HolidayClosure[],
  options: Partial<GapOptions> = {},
): Record<string, GapEstimate> {
  const o = { ...GAP_DEFAULTS, ...options };
  if (candles.length < 2) return {};
  const close = new Map(candles.map((c) => [c.ts, c.close]));
  const first = (candles[0] as Candle).ts;
  const last = (candles.at(-1) as Candle).ts + H;
  const at = (t: number, dir: "before" | "after"): number | undefined => {
    const barEnd = dir === "before" ? Math.floor(t / H) * H : Math.ceil(t / H) * H;
    return close.get(barEnd - H);
  };
  const returns = new Map<string, number[]>();
  for (const span of transitions(first, last, holidays)) {
    if (span.start <= first || !SESSIONS.includes(span.session)) continue;
    const m = Math.round((span.start + span.end) / 2);
    const p0 = at(m, "before");
    if (p0 === undefined) continue;
    for (const to of SESSIONS) {
      if (to === span.session) continue;
      let target: number;
      try {
        target = nextSessionStart(m, to, holidays);
      } catch {
        continue;
      }
      if (to === "regular") target += o.regularOpenSkipMin * 60_000;
      if (target - m > o.maxWaitHours * H || target > last) continue;
      const p1 = at(target, "after");
      if (p1 === undefined) continue;
      const k = `${span.session}->${to}`;
      const list = returns.get(k) ?? [];
      list.push(Math.log(p1 / p0) * 1e4);
      returns.set(k, list);
    }
  }
  const out: Record<string, GapEstimate> = {};
  for (const [k, xs] of [...returns].sort(([a], [b]) => a.localeCompare(b))) {
    out[k] = { sigmaBps: xs.length >= o.minSamples ? robustRms(xs) : Number.NaN, n: xs.length };
  }
  return out;
}

/**
 * σ of the hourly change in log(perp close / rToken close), bps per √hour, over consecutive bars where both venues
 * printed a bar and the rToken was tradable at both ends (a stale rToken close would fake basis moves).
 */
export function basisSigma(
  perp: readonly Candle[],
  rtoken: readonly Candle[],
  sessions: SymbolSessions,
  holidays: readonly HolidayClosure[],
  sessionAt: (ts: number, h: readonly HolidayClosure[]) => { session: Session },
  minSamples = 24,
): GapEstimate {
  const r = new Map(rtoken.map((c) => [c.ts, c.close]));
  const p = new Map(perp.map((c) => [c.ts, c.close]));
  const tradable = (barOpen: number) =>
    venueTradable("rtoken", sessionAt(barOpen, holidays).session, sessions) &&
    venueTradable("rtoken", sessionAt(barOpen + H - 1, holidays).session, sessions);
  const changes: number[] = [];
  for (const [ts, pc] of p) {
    const rc = r.get(ts);
    const pn = p.get(ts + H);
    const rn = r.get(ts + H);
    if (rc === undefined || pn === undefined || rn === undefined) continue;
    if (!tradable(ts) || !tradable(ts + H)) continue;
    changes.push((Math.log(pn / rn) - Math.log(pc / rc)) * 1e4);
  }
  return { sigmaBps: changes.length >= minSamples ? robustRms(changes) : Number.NaN, n: changes.length };
}
