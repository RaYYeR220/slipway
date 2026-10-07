// New York wall-clock helpers for the tide axis (IANA zone via Intl, so DST is handled). Session boundaries are
// the desk's: pre 04:00–09:30, regular 09:30–16:00, after 16:00–20:00, overnight 20:00–04:00, weekend Fri 20:00 →
// Sun 20:00. Spans from now onward come from the server (holiday-aware); these fill in the part of the week behind.
import type { Session } from "./types";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
  hourCycle: "h23",
});
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface NyParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export function nyParts(ts: number): NyParts {
  const o: Record<string, string> = {};
  for (const p of fmt.formatToParts(ts)) o[p.type] = p.value;
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour) % 24,
    minute: Number(o.minute),
    second: Number(o.second),
    weekday: DAYS.indexOf(o.weekday ?? "Sun"),
  };
}

/** UTC ms of a New York wall-clock time (month 1–12; day may overflow, Date.UTC normalises it). */
export function nyToUtc(year: number, month: number, day: number, hour: number, minute = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall + 5 * 3_600_000;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess);
    const asWall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wall - asWall;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function sessionAt(ts: number): Session {
  const p = nyParts(ts);
  const m = p.hour * 60 + p.minute;
  const wd = p.weekday;
  if (wd === 6 || (wd === 5 && m >= 20 * 60) || (wd === 0 && m < 20 * 60)) return "weekend";
  if (m >= 4 * 60 && m < 9 * 60 + 30) return "pre_market";
  if (m >= 9 * 60 + 30 && m < 16 * 60) return "regular";
  if (m >= 16 * 60 && m < 20 * 60) return "after_hours";
  return "overnight";
}

/** Session spans covering [from, to), cut at every boundary. */
export function spansBetween(from: number, to: number): { session: Session; start: number; end: number }[] {
  const out: { session: Session; start: number; end: number }[] = [];
  let t = from;
  let guard = 0;
  while (t < to && guard++ < 400) {
    const s = sessionAt(t);
    const next = nextBoundary(t);
    const end = Math.min(next, to);
    const last = out[out.length - 1];
    if (last && last.session === s && last.end === t) last.end = end;
    else out.push({ session: s, start: t, end });
    t = end;
  }
  return out;
}

const BOUNDS = [4 * 60, 9 * 60 + 30, 16 * 60, 20 * 60];

function nextBoundary(ts: number): number {
  const p = nyParts(ts);
  const m = p.hour * 60 + p.minute + p.second / 60;
  for (const b of BOUNDS) {
    if (b > m + 1e-6) return nyToUtc(p.year, p.month, p.day, Math.floor(b / 60), b % 60);
  }
  return nyToUtc(p.year, p.month, p.day + 1, 4, 0);
}

/**
 * The trading week the tide draws: Sunday 20:00 → Friday 20:00 New York. During the weekend it starts at Friday
 * 20:00 (the still water ahead of the next week) and runs to the following Friday 20:00.
 */
export function tradingWeek(now: number): { start: number; end: number } {
  const p = nyParts(now);
  const s = sessionAt(now);
  if (s === "weekend") {
    const back = p.weekday === 5 ? 0 : p.weekday === 6 ? 1 : 2;
    const start = nyToUtc(p.year, p.month, p.day - back, 20, 0);
    return { start, end: nyToUtc(p.year, p.month, p.day - back + 7, 20, 0) };
  }
  // Sunday 20:00 that opened this week.
  const back = p.weekday === 0 ? 0 : p.weekday;
  const start = nyToUtc(p.year, p.month, p.day - back, 20, 0);
  return { start, end: nyToUtc(p.year, p.month, p.day - back + 5, 20, 0) };
}

/** Midnight New York for each day in [from, to], for day ticks. */
export function midnights(from: number, to: number): { ts: number; weekday: number; day: number }[] {
  const out: { ts: number; weekday: number; day: number }[] = [];
  const p = nyParts(from);
  for (let i = 0; i < 16; i++) {
    const ts = nyToUtc(p.year, p.month, p.day + i, 0, 0);
    if (ts > to) break;
    if (ts >= from) {
      const q = nyParts(ts);
      out.push({ ts, weekday: q.weekday, day: q.day });
    }
  }
  return out;
}

export const DAY_NAMES = DAYS;
