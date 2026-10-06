// New York wall-clock helpers on top of @slipway/core's Intl-based conversion (handles DST).
// Bitget's own "EST"/"standard" labels are never trusted.
import { nyLocalToUtc, nyParts } from "@slipway/core";

/** UTC offset of New York at `ts`, in minutes (-240 during EDT, -300 during EST). */
export function nyOffsetMinutes(ts: number): number {
  const p = nyParts(ts);
  return Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ts / 60_000) * 60_000) / 60_000,
  );
}

export const isNyDaylightTime = (ts: number): boolean => nyOffsetMinutes(ts) === -240;

/** Epoch ms of a New York wall-clock time. */
export const nyWallToUtc = (y: number, m: number, d: number, hh = 0, mm = 0): number =>
  nyLocalToUtc(y, m, d, hh, mm);

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

/** Parses "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" as New York wall clock. Returns NaN when unparseable. */
export function parseNyLocal(s: string): number {
  const m = LOCAL_RE.exec(s.trim());
  if (!m) return Number.NaN;
  return nyWallToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

export function nyDate(ts: number): string {
  const p = nyParts(ts);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Calendar arithmetic on a "YYYY-MM-DD" date string. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** New York wall clock of a "YYYY-MM-DD" date at a given time. */
export function nyAt(ymd: string, hh: number, mm = 0): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return nyWallToUtc(y, m, d, hh, mm);
}
