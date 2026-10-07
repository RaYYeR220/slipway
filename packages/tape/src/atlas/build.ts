// Liquidity atlas (symbol × venue × session) from tape digests + gap/basis σ from candles → derived/atlas.json.
import {
  type Atlas,
  atlasKey,
  type Book,
  buildLiquidityStats,
  framesFromTape,
  type HolidayClosure,
  type LiquidityStats,
  type Session,
  sessionAt,
  type TapeTrade,
  transitions,
  type Venue,
} from "@slipway/core";
import { hourLines } from "../read.js";
import { type BookRecord, lineFor, toBook } from "../records.js";
import { HOUR_MS, hourKey, hourStart, type Stream, type TapeSource } from "../source.js";
import { unpackBook } from "./compact.js";
import type { DigestStore, InstrumentDigest } from "./digest.js";

export interface Coverage {
  snapshots: number; // books15 snapshots used (1 s cadence at most)
  trades: number; // public prints in the same hours
  hours: number; // distinct UTC hours contributing snapshots
}

export interface AtlasDoc {
  generatedAt: number;
  window: { from: number; to: number };
  atlas: Atlas;
  gapSigmaBps: Record<string, Record<string, number>>; // symbol → "venue|from->to" → σ bps
  basisSigmaBpsPerSqrtHour: Record<string, number>;
  coverage: Record<string, Coverage>;
  hourOfWeek: Record<string, HourOfWeekBucket[]>; // "symbol|venue" → buckets with enough data, by NY hour of week
  flags: string[];
}

export interface HourOfWeekBucket {
  hour: number; // 0 = Sunday 00:00 New York … 167 = Saturday 23:00
  spreadBpsP50: number;
  depthUsd25P50: number;
  n: number; // books15 snapshots in the bucket's hour
}

export const HOW_MIN_FRAMES = 60;
export const HOW_MIN_DEPTH = 10;

/**
 * Hour-of-week liquidity profile per instrument: for every NY hour of the week, the most recent recorded UTC hour
 * that maps to it, kept only with ≥ 60 books15 snapshots and ≥ 10 REST depth snapshots.
 */
export async function hourOfWeekProfile(
  digests: DigestStore,
  hours: readonly string[], // newest first
): Promise<Record<string, HourOfWeekBucket[]>> {
  const seen = new Set<string>();
  const out: Record<string, HourOfWeekBucket[]> = {};
  for (const h of hours) {
    for (const x of await digests.summaries(h)) {
      const key = `${x.symbol}|${x.venue}`;
      if (seen.has(`${key}|${x.hourOfWeek}`)) continue;
      if (x.n < HOW_MIN_FRAMES || x.nDepth < HOW_MIN_DEPTH || x.depthUsd25P50 === null) continue;
      seen.add(`${key}|${x.hourOfWeek}`);
      out[key] = [
        ...(out[key] ?? []),
        { hour: x.hourOfWeek, spreadBpsP50: x.spreadBpsP50, depthUsd25P50: x.depthUsd25P50, n: x.n },
      ];
    }
  }
  for (const k of Object.keys(out)) out[k]?.sort((a, b) => a.hour - b.hour);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export const ATLAS_SESSIONS: Session[] = ["pre_market", "regular", "after_hours", "overnight", "weekend"];

export interface AtlasBuildOptions {
  symbols: readonly string[];
  venues?: readonly Venue[];
  holidays: readonly HolidayClosure[];
  now: number;
  maxSessionHours: number; // most recent hours of each session used per key
  lookbackDays: number;
  minFrames: number;
}

export const ATLAS_DEFAULTS = { maxSessionHours: 24, lookbackDays: 14, minFrames: 60 };

export interface KeyResult {
  stats: LiquidityStats | null;
  coverage: Coverage;
  flags: string[];
}

const sessionsInHour = (hour: string, holidays: readonly HolidayClosure[]): Set<Session> => {
  const from = hourStart(hour);
  return new Set(transitions(from, from + HOUR_MS, holidays).map((s) => s.session));
};

/** Real recorded book with exactly this exchange timestamp (the atlas never publishes a compacted book). */
export async function realBook(
  source: TapeSource,
  stream: Stream,
  venue: Venue,
  symbol: string,
  ts: number,
): Promise<Book | null> {
  const needle = lineFor(venue, symbol);
  const tsNeedle = `"ts":${ts}`;
  for await (const line of hourLines(source, stream, hourKey(ts))) {
    if (!line.includes(needle) || !line.includes(tsNeedle)) continue;
    const r = JSON.parse(line) as BookRecord;
    if (r.ts === ts) return toBook(r);
  }
  return null;
}

/** The most recent recorded hours of a session that a key is built from. */
export const pickHours = (hours: readonly string[], session: Session, o: AtlasBuildOptions): string[] =>
  hours.filter((h) => sessionsInHour(h, o.holidays).has(session)).slice(0, o.maxSessionHours);

/** Key results by input signature: closed digest hours are immutable, so unchanged inputs give unchanged stats. */
export type KeyCache = Map<string, { sig: string; result: KeyResult }>;

export async function buildKey(
  digests: DigestStore,
  source: TapeSource,
  symbol: string,
  venue: Venue,
  session: Session,
  hours: readonly string[], // candidate digest hours, newest first
  o: AtlasBuildOptions,
): Promise<KeyResult> {
  const key = atlasKey(symbol, venue, session);
  const picked = pickHours(hours, session, o);
  const books: Book[] = [];
  const depth: Book[] = [];
  const trades: TapeTrade[] = [];
  const contributing = new Set<string>();
  const inSession = (ts: number) => sessionAt(ts, o.holidays).session === session;
  for (const hour of picked) {
    const d: InstrumentDigest | null = await digests.read(hour, venue, symbol);
    if (!d) continue;
    for (const f of d.frames) {
      if (!inSession(f.t)) continue;
      books.push(unpackBook(f, venue, symbol));
      contributing.add(hour);
    }
    for (const f of d.depth) if (inSession(f.t)) depth.push(unpackBook(f, venue, symbol));
    for (const [ts, px, sz, s] of d.trades)
      if (inSession(ts)) trades.push({ ts, px, sz, side: s === 1 ? "buy" : "sell" });
  }
  const coverage: Coverage = { snapshots: books.length, trades: trades.length, hours: contributing.size };
  const flags: string[] = [];
  if (books.length < o.minFrames) {
    if (books.length > 0 || depth.length > 0)
      flags.push(
        `NO_ATLAS_KEY ${key}: ${books.length} books15 snapshots in the last ${picked.length} recorded ${session} hour(s) (< ${o.minFrames}); key omitted`,
      );
    return { stats: null, coverage, flags };
  }
  const frames = framesFromTape(books, trades);
  const stats = buildLiquidityStats({ symbol, venue, session, frames, depthBooks: depth });
  const rep = stats.representativeBook;
  if (rep) {
    const real = await realBook(source, depth.length ? "depth" : "books", venue, symbol, rep.ts);
    if (real) stats.representativeBook = real;
    else {
      delete stats.representativeBook;
      flags.push(`NO_REPRESENTATIVE_BOOK ${key}: recorded book ts=${rep.ts} not found in the tape source`);
    }
  }
  if (!depth.length)
    flags.push(
      `DEPTH_FROM_BOOKS15 ${key}: no REST depth snapshots; depth bands from top-15 books (understated)`,
    );
  if (venue === "rtoken" && trades.length < Math.max(1, coverage.hours))
    flags.push(
      `RTOKEN_TAPE_SILENT ${key}: ${trades.length} public prints over ${coverage.hours} h of books; routed rToken fills do not print on the public tape, so trade flow and touch-hit rate are public-print rates (not imputed)`,
    );
  return { stats, coverage, flags };
}

export async function buildAtlas(
  digests: DigestStore,
  source: TapeSource,
  options: Partial<AtlasBuildOptions> & Pick<AtlasBuildOptions, "symbols" | "holidays" | "now">,
  cache: KeyCache = new Map(),
): Promise<Pick<AtlasDoc, "atlas" | "coverage" | "flags" | "window" | "hourOfWeek">> {
  const o: AtlasBuildOptions = { ...ATLAS_DEFAULTS, ...options };
  const since = hourKey(o.now - o.lookbackDays * 24 * HOUR_MS);
  const hours = (await digests.hours()).filter((h) => h >= since).reverse();
  const atlas: Atlas = {};
  const coverage: Record<string, Coverage> = {};
  const flags: string[] = [];
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const symbol of o.symbols) {
    for (const venue of o.venues ?? (["rtoken", "perp"] as const)) {
      for (const session of ATLAS_SESSIONS) {
        const key = atlasKey(symbol, venue, session);
        const sig = `${o.minFrames}|${o.holidays.length}|${pickHours(hours, session, o).join(",")}`;
        const hit = cache.get(key);
        const r =
          hit?.sig === sig ? hit.result : await buildKey(digests, source, symbol, venue, session, hours, o);
        cache.set(key, { sig, result: r });
        if (r.coverage.snapshots > 0 || r.stats) coverage[key] = r.coverage;
        flags.push(...r.flags);
        if (r.stats) {
          atlas[key] = r.stats;
          from = Math.min(from, r.stats.from);
          to = Math.max(to, r.stats.to);
        }
      }
    }
  }
  return {
    atlas,
    coverage,
    flags,
    hourOfWeek: await hourOfWeekProfile(digests, hours),
    window: { from: Number.isFinite(from) ? from : o.now, to: Number.isFinite(to) ? to : o.now },
  };
}
