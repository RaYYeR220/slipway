// Holiday closures: Bitget's Reality calendar first; core's static NYSE list only for closures Bitget has not
// published yet (flagged). Both use the same convention: closed from 20:00 NY the evening before to 20:00 NY.
import { type HolidayClosure, nyseHolidayClosures } from "@slipway/core";
import type { IntegrityFlag, RealityCalendar } from "./types.js";

export const STATIC_HOLIDAYS_SOURCE = "static.nyse-holidays";
/** When the static list was last checked against Bitget's published closures (Juneteenth, July 3, Labor Day match). */
export const STATIC_HOLIDAYS_AS_OF = Date.UTC(2026, 9, 6);

export function mergeHolidays(
  cal: RealityCalendar | null,
  now: number,
): { closures: HolidayClosure[]; flags: IntegrityFlag[]; staticUsed: number } {
  const published: HolidayClosure[] = (cal?.closures ?? []).map((c) => ({
    start: c.start,
    end: c.end,
    label: c.label ?? `Reality closure ${c.startLocal} -> ${c.endLocal}`,
  }));
  const lastEnd = published.length > 0 ? Math.max(...published.map((c) => c.end)) : null;
  const fill = nyseHolidayClosures().filter((c) => (lastEnd === null || c.start > lastEnd) && c.end > now);
  const flags: IntegrityFlag[] = [];
  if (fill.length > 0) {
    const names = fill.map((c) => c.label ?? new Date(c.end).toISOString().slice(0, 10)).join(", ");
    flags.push(
      !cal
        ? {
            code: "CALENDAR_FALLBACK",
            source: STATIC_HOLIDAYS_SOURCE,
            severity: "warn",
            detail: `Reality calendar unavailable; ${fill.length} upcoming closure(s) from the static NYSE list`,
          }
        : lastEnd === null
          ? {
              code: "CALENDAR_EMPTY",
              source: STATIC_HOLIDAYS_SOURCE,
              severity: "warn",
              detail: `Reality calendar lists no closures; ${fill.length} upcoming closure(s) from the static NYSE list`,
            }
          : {
              code: "CALENDAR_HORIZON",
              source: STATIC_HOLIDAYS_SOURCE,
              severity: "info",
              detail: `Bitget's Reality calendar publishes no closure after ${new Date(lastEnd).toISOString().slice(0, 10)}; ${fill.length} upcoming NYSE closure(s) taken from the static list: ${names}`,
            },
    );
  }
  return {
    closures: [...published, ...fill].sort((a, b) => a.start - b.start),
    flags,
    staticUsed: fill.length,
  };
}
