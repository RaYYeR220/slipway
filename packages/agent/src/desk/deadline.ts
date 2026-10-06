// Deadlines arrive as the trader phrased them ("before thursday", "in 2h"); code, not the model, turns them
// into an instant so date arithmetic is deterministic and testable. Times are New York wall clock.
import { type HolidayClosure, nextSessionStart, nyLocalToUtc, nyParts, sessionAt } from "@slipway/core";

export type Deadline =
  | { ok: true; ts: number; nyLocal: string; reading: string }
  | { ok: false; error: string };

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CLOSE = { h: 16, m: 0 };

function nyDayAt(now: number, addDays: number, h: number, m: number): number {
  const p = nyParts(now);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return nyLocalToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m);
}

function hhmm(s: string | undefined): { h: number; m: number } | null {
  if (!s) return null;
  const x = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s.trim());
  if (!x) return null;
  let h = Number(x[1]);
  const m = Number(x[2] ?? 0);
  if (x[3] === "pm" && h < 12) h += 12;
  if (x[3] === "am" && h === 12) h = 0;
  return h < 24 && m < 60 ? { h, m } : null;
}

export function parseDeadline(raw: string, now: number, holidays: readonly HolidayClosure[] = []): Deadline {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/\s+(ny|et|est|edt|new york)$/, "")
    .replace(/\s+/g, " ");
  const ok = (ts: number, reading: string): Deadline =>
    ts <= now
      ? {
          ok: false,
          error: `"${raw}" resolves to ${sessionAt(ts, holidays).nyLocal} NY, which is already past`,
        }
      : { ok: true, ts, nyLocal: sessionAt(ts, holidays).nyLocal, reading };

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2}))?$/.exec(text);
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const t = iso[4] ? { h: Number(iso[4]), m: Number(iso[5]) } : CLOSE;
    return ok(nyLocalToUtc(y, mo, d, t.h, t.m), iso[4] ? "New York wall clock" : "that day's regular close");
  }

  const rel = /^(?:in |\+)?(\d+(?:\.\d+)?) ?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] as string)[0];
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return ok(now + n * ms, "relative to now");
  }

  if (/^(now|asap|immediately|right away|right now)$/.test(text))
    return ok(now + 15 * 60_000, "as soon as possible: a fifteen-minute window");
  if (/^(today|eod|end of day|close|today close|by the close|by close|before the close)$/.test(text))
    return ok(nyDayAt(now, 0, CLOSE.h, CLOSE.m), "today's regular close");
  if (/^(tomorrow|tmrw|tomorrow close|by tomorrow)$/.test(text))
    return ok(nyDayAt(now, 1, CLOSE.h, CLOSE.m), "tomorrow's regular close");
  if (/^(before (the )?(next )?open|(the )?(next )?open|at the open)$/.test(text))
    return ok(nextSessionStart(now, "regular", holidays), "next regular-session open");

  const wd = /^(before|by|until|till|on)? ?([a-z]+)(?: (?:at )?(.+))?$/.exec(text);
  const day = wd ? WEEKDAYS[wd[2] as string] : undefined;
  if (wd && day !== undefined) {
    const at = hhmm(wd[3]);
    if (wd[3] && !at) return { ok: false, error: `cannot read the time in "${raw}"` };
    const today = nyParts(now).weekday;
    let ahead = (day - today + 7) % 7;
    if (ahead === 0) ahead = 7;
    const name = DAY_NAMES[day] as string;
    if (at) {
      const sameDay = (day - today + 7) % 7 === 0 && nyDayAt(now, 0, at.h, at.m) > now;
      return ok(nyDayAt(now, sameDay ? 0 : ahead, at.h, at.m), `${name} at the stated time`);
    }
    if (wd[1] === "before") return ok(nyDayAt(now, ahead, 0, 0), `start of ${name}`);
    const sameDayClose = (day - today + 7) % 7 === 0 && nyDayAt(now, 0, CLOSE.h, CLOSE.m) > now;
    return ok(nyDayAt(now, sameDayClose ? 0 : ahead, CLOSE.h, CLOSE.m), `${name}'s regular close`);
  }
  return {
    ok: false,
    error: `cannot read deadline "${raw}"; use e.g. "by friday", "thursday 16:00", "in 2h" or "YYYY-MM-DD HH:mm"`,
  };
}
