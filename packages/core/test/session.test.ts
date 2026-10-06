import { describe, expect, it } from "vitest";
import {
  hourOfWeek,
  nextSessionStart,
  nyLocalToUtc,
  nyseHolidayClosures,
  sessionAt,
  transitions,
  venueTradable,
} from "../src/session.js";
import type { SymbolSessions } from "../src/types.js";

const T = (iso: string) => Date.parse(iso);
const holidays = nyseHolidayClosures();

describe("sessionAt", () => {
  it("classifies the recorded tape hours (EDT, UTC-4)", () => {
    expect(sessionAt(T("2026-10-05T23:30:00Z"))).toEqual({
      session: "after_hours",
      nyLocal: "2026-10-05 19:30",
      weekday: 1,
    });
    expect(sessionAt(T("2026-10-06T02:30:00Z")).session).toBe("overnight");
  });

  it("uses inclusive starts at every weekday boundary", () => {
    expect(sessionAt(T("2026-10-06T07:59:59.999Z")).session).toBe("overnight");
    expect(sessionAt(T("2026-10-06T08:00:00Z")).session).toBe("pre_market");
    expect(sessionAt(T("2026-10-06T13:29:59.999Z")).session).toBe("pre_market");
    expect(sessionAt(T("2026-10-06T13:30:00Z")).session).toBe("regular");
    expect(sessionAt(T("2026-10-06T20:00:00Z")).session).toBe("after_hours");
    expect(sessionAt(T("2026-10-07T00:00:00Z")).session).toBe("overnight");
  });

  it("runs the weekend from Friday 20:00 to Sunday 20:00 NY", () => {
    expect(sessionAt(T("2026-10-09T23:59:59.999Z")).session).toBe("after_hours");
    expect(sessionAt(T("2026-10-10T00:00:00Z")).session).toBe("weekend");
    expect(sessionAt(T("2026-10-10T16:00:00Z")).session).toBe("weekend");
    expect(sessionAt(T("2026-10-11T23:59:59.999Z")).session).toBe("weekend");
    expect(sessionAt(T("2026-10-12T00:00:00Z"))).toEqual({
      session: "overnight",
      nyLocal: "2026-10-11 20:00",
      weekday: 0,
    });
  });

  it("follows the DST fall-back on 2026-11-01 (weekend ends at 01:00Z, not 00:00Z)", () => {
    expect(sessionAt(T("2026-11-02T00:30:00Z"))).toEqual({
      session: "weekend",
      nyLocal: "2026-11-01 19:30",
      weekday: 0,
    });
    expect(sessionAt(T("2026-11-02T01:00:00Z")).session).toBe("overnight");
    expect(sessionAt(T("2026-11-02T14:29:00Z")).session).toBe("pre_market");
    expect(sessionAt(T("2026-11-02T14:30:00Z")).session).toBe("regular");
  });

  it("follows the DST spring-forward on 2026-03-08 (weekend ends at 00:00Z, not 01:00Z)", () => {
    expect(sessionAt(T("2026-03-08T23:59:00Z")).session).toBe("weekend");
    expect(sessionAt(T("2026-03-09T00:00:00Z"))).toEqual({
      session: "overnight",
      nyLocal: "2026-03-08 20:00",
      weekday: 0,
    });
    expect(sessionAt(T("2026-03-09T13:30:00Z")).session).toBe("regular");
    expect(sessionAt(T("2026-03-06T14:30:00Z")).session).toBe("regular"); // Friday before, still EST
    expect(sessionAt(T("2026-03-06T14:29:00Z")).session).toBe("pre_market");
  });

  it("reports both 01:30 local instants of the repeated hour as 01:30", () => {
    expect(sessionAt(T("2026-11-01T05:30:00Z")).nyLocal).toBe("2026-11-01 01:30");
    expect(sessionAt(T("2026-11-01T06:30:00Z")).nyLocal).toBe("2026-11-01 01:30");
  });

  it("marks holiday closures as closed only when a calendar is supplied", () => {
    const thanksgivingOpen = T("2026-11-26T15:00:00Z");
    expect(sessionAt(thanksgivingOpen).session).toBe("regular");
    expect(sessionAt(thanksgivingOpen, holidays).session).toBe("closed");
    // the closure covers the trading day's overnight lead-in (Wed 20:00 EST) up to Thu 20:00 EST
    expect(sessionAt(T("2026-11-26T00:59:00Z"), holidays).session).toBe("after_hours");
    expect(sessionAt(T("2026-11-26T01:00:00Z"), holidays).session).toBe("closed");
    expect(sessionAt(T("2026-11-27T01:00:00Z"), holidays).session).toBe("overnight");
  });
});

describe("nyLocalToUtc", () => {
  it("inverts NY wall time on both sides of each DST switch", () => {
    expect(nyLocalToUtc(2026, 3, 6, 9, 30)).toBe(T("2026-03-06T14:30:00Z"));
    expect(nyLocalToUtc(2026, 3, 9, 9, 30)).toBe(T("2026-03-09T13:30:00Z"));
    expect(nyLocalToUtc(2026, 10, 30, 16, 0)).toBe(T("2026-10-30T20:00:00Z"));
    expect(nyLocalToUtc(2026, 11, 2, 9, 30)).toBe(T("2026-11-02T14:30:00Z"));
  });
});

describe("nyseHolidayClosures", () => {
  it("covers the 2026 NYSE full-day holidays with a fallback label", () => {
    const labels = holidays.filter((h) => h.start < T("2027-01-01T00:00:00Z")).map((h) => h.label);
    expect(labels).toHaveLength(10);
    expect(labels.every((l) => l?.includes("static fallback"))).toBe(true);
    const july = holidays.find((h) => h.label?.startsWith("2026-07-03"));
    expect(july).toBeDefined();
  });
});

describe("nextSessionStart", () => {
  it("finds the next regular open from the overnight session", () => {
    expect(nextSessionStart(T("2026-10-06T02:30:00Z"), "regular")).toBe(T("2026-10-06T13:30:00Z"));
  });

  it("skips the weekend", () => {
    expect(nextSessionStart(T("2026-10-09T22:00:00Z"), "regular")).toBe(T("2026-10-12T13:30:00Z"));
    expect(nextSessionStart(T("2026-10-09T22:00:00Z"), "weekend")).toBe(T("2026-10-10T00:00:00Z"));
  });

  it("lands on the post-DST open after the fall-back weekend", () => {
    expect(nextSessionStart(T("2026-10-30T21:00:00Z"), "regular")).toBe(T("2026-11-02T14:30:00Z"));
    expect(nextSessionStart(T("2026-10-31T12:00:00Z"), "overnight")).toBe(T("2026-11-02T01:00:00Z"));
  });

  it("returns the next occurrence, not the one in progress", () => {
    expect(nextSessionStart(T("2026-10-06T02:30:00Z"), "overnight")).toBe(T("2026-10-07T00:00:00Z"));
    expect(nextSessionStart(T("2026-10-06T13:30:00Z"), "regular")).toBe(T("2026-10-07T13:30:00Z"));
  });

  it("skips a holiday when the calendar is supplied", () => {
    const wedAfterHours = T("2026-11-25T22:00:00Z");
    expect(nextSessionStart(wedAfterHours, "regular")).toBe(T("2026-11-26T14:30:00Z"));
    expect(nextSessionStart(wedAfterHours, "regular", holidays)).toBe(T("2026-11-27T14:30:00Z"));
  });

  it("throws when the target never occurs within the search horizon", () => {
    expect(() => nextSessionStart(T("2026-10-06T02:30:00Z"), "closed")).toThrow(/closed/);
  });
});

describe("transitions", () => {
  it("splits Friday afternoon to Monday morning into contiguous spans", () => {
    const from = T("2026-10-09T19:00:00Z");
    const to = T("2026-10-12T14:00:00Z");
    expect(transitions(from, to)).toEqual([
      { session: "regular", start: from, end: T("2026-10-09T20:00:00Z") },
      { session: "after_hours", start: T("2026-10-09T20:00:00Z"), end: T("2026-10-10T00:00:00Z") },
      { session: "weekend", start: T("2026-10-10T00:00:00Z"), end: T("2026-10-12T00:00:00Z") },
      { session: "overnight", start: T("2026-10-12T00:00:00Z"), end: T("2026-10-12T08:00:00Z") },
      { session: "pre_market", start: T("2026-10-12T08:00:00Z"), end: T("2026-10-12T13:30:00Z") },
      { session: "regular", start: T("2026-10-12T13:30:00Z"), end: to },
    ]);
  });

  it("stretches the weekend span by an hour across the fall-back", () => {
    const spans = transitions(T("2026-10-30T23:00:00Z"), T("2026-11-02T03:00:00Z"));
    const weekend = spans.find((s) => s.session === "weekend");
    expect(weekend).toEqual({
      session: "weekend",
      start: T("2026-10-31T00:00:00Z"),
      end: T("2026-11-02T01:00:00Z"),
    });
  });

  it("inserts a closed span for a holiday", () => {
    const spans = transitions(T("2026-11-25T22:00:00Z"), T("2026-11-27T02:00:00Z"), holidays);
    expect(spans.map((s) => s.session)).toEqual(["after_hours", "closed", "overnight"]);
  });

  it("returns an empty list for an empty interval", () => {
    expect(transitions(T("2026-10-06T02:30:00Z"), T("2026-10-06T02:30:00Z"))).toEqual([]);
  });
});

describe("venueTradable", () => {
  const nvda: SymbolSessions = {
    symbol: "NVDA",
    tradingPeriods: ["pre_market", "regular", "after_hours", "overnight"],
    weekendTradable: false,
  };

  it("opens the rToken only in its listed sessions", () => {
    expect(venueTradable("rtoken", "overnight", nvda)).toBe(true);
    expect(venueTradable("rtoken", "weekend", nvda)).toBe(false);
    expect(venueTradable("rtoken", "weekend", { ...nvda, weekendTradable: true })).toBe(true);
    expect(venueTradable("rtoken", "closed", nvda)).toBe(false);
  });

  it("treats the perp as 24/7", () => {
    expect(venueTradable("perp", "weekend", nvda)).toBe(true);
    expect(venueTradable("perp", "closed", nvda)).toBe(true);
  });
});

describe("hourOfWeek", () => {
  it("buckets NY local time into 0..167 starting Sunday 00:00", () => {
    expect(hourOfWeek(T("2026-10-06T02:30:00Z"))).toBe(1 * 24 + 22); // Mon 22:30 EDT
    expect(hourOfWeek(T("2026-10-11T04:00:00Z"))).toBe(0); // Sun 00:00 EDT
    expect(hourOfWeek(T("2026-10-11T03:59:00Z"))).toBe(167); // Sat 23:59 EDT
  });

  it("keeps the wall-clock bucket across the DST switch", () => {
    expect(hourOfWeek(T("2026-11-02T14:30:00Z"))).toBe(hourOfWeek(T("2026-10-26T13:30:00Z"))); // Mon 09:30 EST vs EDT
  });
});
