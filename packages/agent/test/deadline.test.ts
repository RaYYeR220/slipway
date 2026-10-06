import { nyseHolidayClosures, sessionAt } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { parseDeadline } from "../src/desk/deadline.js";

// Tuesday 2026-10-06 01:02 New York (EDT), the moment the REST fixtures were recorded.
const NOW = Date.UTC(2026, 9, 6, 5, 2, 21);
const ny = (raw: string) => {
  const d = parseDeadline(raw, NOW, nyseHolidayClosures());
  if (!d.ok) throw new Error(d.error);
  return sessionAt(d.ts).nyLocal;
};

describe("parseDeadline (New York wall clock, deterministic)", () => {
  it("reads weekday phrasing: 'before' = start of that day, 'by' = its regular close", () => {
    expect(ny("before Thursday")).toBe("2026-10-08 00:00");
    expect(ny("by thursday")).toBe("2026-10-08 16:00");
    expect(ny("thursday")).toBe("2026-10-08 16:00");
    expect(ny("thu 09:45")).toBe("2026-10-08 09:45");
    expect(ny("friday at 3pm")).toBe("2026-10-09 15:00");
    expect(ny("by tuesday")).toBe("2026-10-06 16:00"); // later today
    expect(ny("before tuesday")).toBe("2026-10-13 00:00"); // today has started: next week
  });

  it("reads relative, same-day and session phrasing", () => {
    expect(ny("in 2h")).toBe("2026-10-06 03:02");
    expect(ny("+90m")).toBe("2026-10-06 02:32");
    expect(ny("today")).toBe("2026-10-06 16:00");
    expect(ny("end of day")).toBe("2026-10-06 16:00");
    expect(ny("tomorrow")).toBe("2026-10-07 16:00");
    expect(ny("before the open")).toBe("2026-10-06 09:30");
  });

  it("reads explicit New York timestamps and dates (date alone = regular close)", () => {
    expect(ny("2026-10-08 10:30")).toBe("2026-10-08 10:30");
    expect(ny("2026-10-09")).toBe("2026-10-09 16:00");
    expect(ny("2026-10-09 11:00 ET")).toBe("2026-10-09 11:00");
  });

  it("refuses past and unreadable deadlines instead of guessing", () => {
    const past = parseDeadline("2026-10-05 12:00", NOW);
    expect(past.ok).toBe(false);
    expect(!past.ok && past.error).toMatch(/already past/);
    expect(parseDeadline("whenever", NOW).ok).toBe(false);
    expect(parseDeadline("thursday 25:00", NOW).ok).toBe(false);
  });
});
