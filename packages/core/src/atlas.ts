import { depthWithin, mid, spreadBps } from "./book.js";
import { estimateResilience, type ResilienceOptions, type TapeFrame } from "./resilience.js";
import { median, quantile, quantiles3, robustRms } from "./stats.js";
import {
  type Atlas,
  atlasKey,
  type Book,
  type DepthBand,
  type LiquidityStats,
  type Session,
  type Venue,
} from "./types.js";

export interface AtlasInput {
  symbol: string;
  venue: Venue;
  session: Session;
  frames: readonly TapeFrame[]; // ~1 s top-of-book snapshots with the trades printed between them
  depthBooks?: readonly Book[]; // full-depth snapshots; preferred for depth bands and the representative book
  sigma?: Partial<SigmaOptions>;
  resilience?: Partial<ResilienceOptions>;
}

export interface SigmaOptions {
  horizonSec: number;
  maxStaleSec: number; // a grid point whose last snapshot is older than this is a data gap
}

const SIGMA_DEFAULTS: SigmaOptions = { horizonSec: 10, maxStaleSec: 300 };

const perSideDepth = (book: Book, bps: number) =>
  (depthWithin(book, "buy", bps).notional + depthWithin(book, "sell", bps).notional) / 2;

const band = (xs: number[]): DepthBand => ({ p10: quantile(xs, 0.1), p50: quantile(xs, 0.5) });

// RMS of non-overlapping log-mid returns on a last-value grid, scaled to 1 s. 1 s changes on these books are
// 70–97% exact zeros, so a MAD of 1 s changes is degenerate; robustRms clips glitches instead.
export function sigmaBpsPerSqrtSec(
  frames: readonly TapeFrame[],
  options: Partial<SigmaOptions> = {},
): number {
  const o = { ...SIGMA_DEFAULTS, ...options };
  if (frames.length < 2) return Number.NaN;
  const step = o.horizonSec * 1000;
  const first = (frames[0] as TapeFrame).ts;
  const last = (frames.at(-1) as TapeFrame).ts;
  const returns: number[] = [];
  let j = 0;
  let prev: { mid: number; stale: boolean } | null = null;
  for (let t = first; t <= last; t += step) {
    while (j + 1 < frames.length && (frames[j + 1] as TapeFrame).ts <= t) j++;
    const f = frames[j] as TapeFrame;
    const cur = { mid: mid(f.book), stale: t - f.ts > o.maxStaleSec * 1000 };
    if (prev && !prev.stale && !cur.stale) returns.push(Math.log(cur.mid / prev.mid) * 1e4);
    prev = cur;
  }
  return returns.length >= 2 ? robustRms(returns) / Math.sqrt(o.horizonSec) : Number.NaN;
}

export function buildLiquidityStats(input: AtlasInput): LiquidityStats {
  const { frames } = input;
  if (frames.length === 0)
    throw new Error(`no snapshots for ${input.symbol} ${input.venue} ${input.session}`);
  const from = (frames[0] as TapeFrame).ts;
  const to = (frames.at(-1) as TapeFrame).ts;
  const depthBooks = input.depthBooks?.length ? input.depthBooks : frames.map((f) => f.book);
  const d10 = depthBooks.map((b) => perSideDepth(b, 10));
  const d25 = depthBooks.map((b) => perSideDepth(b, 25));
  const d50 = depthBooks.map((b) => perSideDepth(b, 50));

  const minutes = Math.max(1, Math.ceil((to - from) / 60_000));
  const perMinute = new Array<number>(minutes).fill(0);
  const sizes: number[] = [];
  let touchHits = 0;
  frames.forEach((f, i) => {
    const prev = i > 0 ? (frames[i - 1] as TapeFrame).book : null;
    for (const t of f.trades) {
      const bucket = Math.min(minutes - 1, Math.max(0, Math.floor((t.ts - from) / 60_000)));
      perMinute[bucket] = (perMinute[bucket] as number) + t.px * t.sz;
      sizes.push(t.sz);
      const ask = prev?.asks[0]?.px;
      const bid = prev?.bids[0]?.px;
      if (
        (t.side === "buy" && ask !== undefined && t.px >= ask) ||
        (t.side === "sell" && bid !== undefined && t.px <= bid)
      ) {
        touchHits++;
      }
    }
  });

  const m25 = median(d25);
  let representative: Book | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  depthBooks.forEach((b, i) => {
    const gap = Math.abs((d25[i] as number) - m25);
    if (gap <= bestGap) {
      bestGap = gap;
      representative = b;
    }
  });

  const stats: LiquidityStats = {
    symbol: input.symbol,
    venue: input.venue,
    session: input.session,
    n: frames.length,
    from,
    to,
    spreadBps: quantiles3(frames.map((f) => spreadBps(f.book))),
    depthUsd: { b10: band(d10), b25: band(d25), b50: band(d50) },
    resilience: estimateResilience(frames, input.resilience),
    sigmaBpsPerSqrtSec: sigmaBpsPerSqrtSec(frames, input.sigma),
    tradeNotionalPerMin: { p50: median(perMinute), mean: perMinute.reduce((s, x) => s + x, 0) / minutes },
    // per side: the rate at which one resting side of the touch gets hit
    touchHitRatePerMin: touchHits / 2 / minutes,
    medianTradeQty: sizes.length ? median(sizes) : 0,
  };
  if (representative) stats.representativeBook = representative;
  return stats;
}

export function buildAtlas(stats: readonly LiquidityStats[]): Atlas {
  const atlas: Atlas = {};
  for (const s of stats) atlas[atlasKey(s.symbol, s.venue, s.session)] = s;
  return atlas;
}
