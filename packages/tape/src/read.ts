// Streaming reads of hourly gzip JSONL. The newest hour is still being written, so its gzip stream ends mid-block:
// it is decompressed with a sync flush and read up to the last complete line instead of failing.
import { createGunzip, constants as zc } from "node:zlib";
import type { Book, Venue } from "@slipway/core";
import { type BookRecord, instId, instType, lineFor, toBook } from "./records.js";
import { HOUR_MS, hourKey, hourStart, type Stream, type TapeSource } from "./source.js";

export interface HourStats {
  lines: number;
  bad: number; // unparseable lines (the truncated tail of an open hour)
  truncated: boolean;
}

/** Raw lines of one hour file; lines failing `filter` are skipped before JSON parsing. */
export async function* hourLines(
  source: TapeSource,
  stream: Stream,
  hour: string,
  stats?: HourStats,
): AsyncGenerator<string> {
  const raw = await source.open(stream, hour);
  if (!raw) return;
  const gunzip = createGunzip({ finishFlush: zc.Z_SYNC_FLUSH });
  let failed: Error | null = null;
  raw.on("error", (e) => gunzip.destroy(e));
  gunzip.on("error", (e) => {
    failed = e;
  });
  raw.pipe(gunzip);
  let rest = "";
  try {
    for await (const chunk of gunzip) {
      const text = rest + (chunk as Buffer).toString("utf8");
      let start = 0;
      for (let nl = text.indexOf("\n", start); nl !== -1; nl = text.indexOf("\n", start)) {
        if (nl > start) {
          if (stats) stats.lines++;
          yield text.slice(start, nl);
        }
        start = nl + 1;
      }
      rest = text.slice(start);
    }
  } catch (e) {
    failed = e as Error;
  }
  if (stats) {
    stats.truncated = failed !== null || rest.length > 0;
    if (rest.length > 0) stats.bad++;
  }
  if (failed && !/unexpected end of file/i.test((failed as Error).message)) {
    raw.destroy();
    throw failed;
  }
}

/** Hour keys of a stream overlapping [from, to]. */
export async function hoursIn(
  source: TapeSource,
  stream: Stream,
  from: number,
  to: number,
): Promise<string[]> {
  const lo = hourKey(from);
  const hi = hourKey(to);
  return (await source.hours(stream)).filter((h) => h >= lo && h <= hi);
}

export interface ReadOptions {
  from: number;
  to: number;
  /** Substrings a line must contain (any of them) to be parsed. */
  match?: string[];
}

/** Parsed records with `ts` in [from, to], hour by hour (records within an hour are in recorder write order). */
export async function* records<T extends { ts: number }>(
  source: TapeSource,
  stream: Stream,
  o: ReadOptions,
): AsyncGenerator<T> {
  for (const hour of await hoursIn(source, stream, o.from, o.to)) {
    for await (const line of hourLines(source, stream, hour)) {
      if (o.match && !o.match.some((m) => line.includes(m))) continue;
      let r: T;
      try {
        r = JSON.parse(line) as T;
      } catch {
        continue;
      }
      if (r.ts >= o.from && r.ts <= o.to) yield r;
    }
  }
}

export interface Probe {
  venue: Venue;
  symbol: string;
  ts: number;
}

export interface BookMatch {
  book: Book;
  gapMs: number; // |book.ts − probe.ts|
}

/**
 * Nearest recorded book (by exchange timestamp) to each probe, within maxGapMs. Streams each needed hour once and
 * keeps only the current best candidate per probe, so memory is O(probes), not O(tape).
 */
export async function nearestBooks(
  source: TapeSource,
  probes: readonly Probe[],
  maxGapMs: number,
  stream: Stream = "books",
): Promise<(BookMatch | null)[]> {
  const best: ({ rec: BookRecord; gap: number } | null)[] = probes.map(() => null);
  const byInst = new Map<string, { ts: number; i: number }[]>();
  const hours = new Set<string>();
  probes.forEach((p, i) => {
    const key = `${instType(p.venue)}|${instId(p.venue, p.symbol)}`;
    const list = byInst.get(key) ?? [];
    list.push({ ts: p.ts, i });
    byInst.set(key, list);
    hours.add(hourKey(p.ts - maxGapMs));
    hours.add(hourKey(p.ts + maxGapMs));
  });
  for (const list of byInst.values()) list.sort((a, b) => a.ts - b.ts);
  const needles = [...new Set(probes.map((p) => lineFor(p.venue, p.symbol)))];
  const available = new Set(await source.hours(stream));
  for (const hour of [...hours].sort()) {
    if (!available.has(hour)) continue;
    for await (const line of hourLines(source, stream, hour)) {
      if (!needles.some((n) => line.includes(n))) continue;
      let r: BookRecord;
      try {
        r = JSON.parse(line) as BookRecord;
      } catch {
        continue;
      }
      const list = byInst.get(`${r.instType}|${r.instId}`);
      if (!list) continue;
      let lo = lowerBound(list, r.ts - maxGapMs);
      for (; lo < list.length && (list[lo] as { ts: number }).ts <= r.ts + maxGapMs; lo++) {
        const { ts, i } = list[lo] as { ts: number; i: number };
        const gap = Math.abs(r.ts - ts);
        const cur = best[i];
        // ties go to the earlier snapshot (the state already visible at the probe time)
        if (!cur || gap < cur.gap || (gap === cur.gap && r.ts < cur.rec.ts)) best[i] = { rec: r, gap };
      }
    }
  }
  return best.map((b) => (b ? { book: toBook(b.rec), gapMs: b.gap } : null));
}

function lowerBound(list: readonly { ts: number }[], ts: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as { ts: number }).ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Latest exchange timestamp recorded in a stream's newest hour (how far the tape reaches). */
export async function tapeEnd(source: TapeSource, stream: Stream = "books"): Promise<number | null> {
  const hours = await source.hours(stream);
  for (let k = hours.length - 1; k >= 0 && k >= hours.length - 2; k--) {
    let max = Number.NEGATIVE_INFINITY;
    for await (const line of hourLines(source, stream, hours[k] as string)) {
      const m = /"ts":(\d+)/.exec(line);
      if (m) max = Math.max(max, Number(m[1]));
    }
    if (Number.isFinite(max)) return max;
  }
  return null;
}

export const hourRange = (hour: string): { from: number; to: number } => {
  const from = hourStart(hour);
  return { from, to: from + HOUR_MS - 1 };
};
