import type { HolidayClosure, Session, SessionInfo, SymbolSessions, Venue } from "./types.js";

export interface NyParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

export interface SessionSpan {
  session: Session;
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;
const SEARCH_HORIZON_MS = 21 * DAY_MS;
// Session boundaries in NY wall-clock minutes; weekend edges coincide with the 20:00 boundary.
const BOUNDARY_MINUTES = [4 * 60, 9 * 60 + 30, 16 * 60, 20 * 60];

const nyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const HOUR_MS = 3_600_000;
const offsetByHour = new Map<number, number>();

// NY switches DST at 02:00 local, which is always a whole UTC hour, so the offset is constant per UTC hour.
function nyOffsetMs(ts: number): number {
  const hour = Math.floor(ts / HOUR_MS);
  let offset = offsetByHour.get(hour);
  if (offset === undefined) {
    const p: Record<string, number> = {};
    for (const part of nyFormatter.formatToParts(hour * HOUR_MS)) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    const wall = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0);
    offset = wall - hour * HOUR_MS;
    if (offsetByHour.size > 50_000) offsetByHour.clear();
    offsetByHour.set(hour, offset);
  }
  return offset;
}

export function nyParts(ts: number): NyParts {
  const d = new Date(ts + nyOffsetMs(ts));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

// Wall-clock → UTC by fixed-point on the zone offset; ambiguous fall-back times resolve to the first (EDT) instant.
export function nyLocalToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let ts = wall + 4 * 3_600_000;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(ts);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ts / 60_000) * 60_000;
    const next = wall - offset;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

const pad = (n: number) => String(n).padStart(2, "0");

function weeklySession(weekday: number, minutes: number): Session {
  const [pre, regular, after, evening] = BOUNDARY_MINUTES as [number, number, number, number];
  if ((weekday === 5 && minutes >= evening) || weekday === 6 || (weekday === 0 && minutes < evening))
    return "weekend";
  if (minutes >= evening || minutes < pre) return "overnight";
  if (minutes < regular) return "pre_market";
  if (minutes < after) return "regular";
  return "after_hours";
}

export function sessionAt(ts: number, holidays: readonly HolidayClosure[] = []): SessionInfo {
  const p = nyParts(ts);
  const nyLocal = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  const closed = holidays.some((h) => ts >= h.start && ts < h.end);
  const session = closed ? "closed" : weeklySession(p.weekday, p.hour * 60 + p.minute);
  return { session, nyLocal, weekday: p.weekday };
}

// NY wall-clock hour of the week, 0 = Sunday 00:00 … 167 = Saturday 23:00 (atlas sub-bucket).
export function hourOfWeek(ts: number): number {
  const p = nyParts(ts);
  return p.weekday * 24 + p.hour;
}

export function transitions(
  from: number,
  to: number,
  holidays: readonly HolidayClosure[] = [],
): SessionSpan[] {
  if (!(to > from)) return [];
  const cuts = new Set<number>([from, to]);
  const first = nyParts(from);
  const days = Math.ceil((to - from) / DAY_MS) + 2;
  for (let i = -1; i <= days; i++) {
    const d = new Date(Date.UTC(first.year, first.month - 1, first.day + i));
    for (const m of BOUNDARY_MINUTES) {
      const t = nyLocalToUtc(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        Math.floor(m / 60),
        m % 60,
      );
      if (t > from && t < to) cuts.add(t);
    }
  }
  for (const h of holidays) {
    if (h.start > from && h.start < to) cuts.add(h.start);
    if (h.end > from && h.end < to) cuts.add(h.end);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const spans: SessionSpan[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i] as number;
    const end = sorted[i + 1] as number;
    const session = sessionAt(start, holidays).session;
    const last = spans.at(-1);
    if (last && last.session === session) last.end = end;
    else spans.push({ session, start, end });
  }
  return spans;
}

export function nextSessionStart(
  ts: number,
  target: Session,
  holidays: readonly HolidayClosure[] = [],
): number {
  const span = transitions(ts, ts + SEARCH_HORIZON_MS, holidays).find(
    (s) => s.session === target && s.start > ts,
  );
  if (!span) throw new Error(`no ${target} session within ${SEARCH_HORIZON_MS / DAY_MS} days of ${ts}`);
  return span.start;
}

// Perps are treated as 24/7 (an assumption the tape verifies for the sessions it covers).
export function venueTradable(venue: Venue, session: Session, sessions: SymbolSessions): boolean {
  if (venue === "perp") return true;
  if (session === "closed") return false;
  if (session === "weekend") return sessions.weekendTradable;
  return sessions.tradingPeriods.includes(session);
}

export const NYSE_HOLIDAYS: readonly { date: string; label: string }[] = [
  { date: "2026-01-01", label: "New Year's Day" },
  { date: "2026-01-19", label: "Martin Luther King Jr. Day" },
  { date: "2026-02-16", label: "Washington's Birthday" },
  { date: "2026-04-03", label: "Good Friday" },
  { date: "2026-05-25", label: "Memorial Day" },
  { date: "2026-06-19", label: "Juneteenth" },
  { date: "2026-07-03", label: "Independence Day (observed)" },
  { date: "2026-09-07", label: "Labor Day" },
  { date: "2026-11-26", label: "Thanksgiving Day" },
  { date: "2026-12-25", label: "Christmas Day" },
  { date: "2027-01-01", label: "New Year's Day" },
  { date: "2027-01-18", label: "Martin Luther King Jr. Day" },
  { date: "2027-02-15", label: "Washington's Birthday" },
  { date: "2027-03-26", label: "Good Friday" },
  { date: "2027-05-31", label: "Memorial Day" },
  { date: "2027-06-18", label: "Juneteenth (observed)" },
  { date: "2027-07-05", label: "Independence Day (observed)" },
  { date: "2027-09-06", label: "Labor Day" },
  { date: "2027-11-25", label: "Thanksgiving Day" },
  { date: "2027-12-24", label: "Christmas Day (observed)" },
];

// A holiday closes its whole trading day: the overnight lead-in from the prior 20:00 through 20:00 on the day.
export function nyseHolidayClosures(): HolidayClosure[] {
  return NYSE_HOLIDAYS.map(({ date, label }) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    return {
      start: nyLocalToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 20, 0),
      end: nyLocalToUtc(y, m, d, 20, 0),
      label: `${date} ${label} (NYSE static fallback)`,
    };
  });
}
