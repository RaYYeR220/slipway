import { describe, expect, it } from "vitest";
import { mid } from "../src/book.js";
import { buildPlan, LAMBDA, planExecution } from "../src/planner.js";
import type { OrderIntent, Profile, StrategyQuote } from "../src/types.js";
import { must } from "./helpers.js";
import { liveBook, nvdaSnapshot, retime } from "./market.js";

const desk: Profile = {
  name: "desk",
  urgency: "normal",
  costCapBps: 50,
  maxParticipation: 0.25,
  allowPerp: true,
  maxLeverage: 1,
  avoidSessions: [],
  avoidEvents: true,
};
const snap = nvdaSnapshot("overnight");
const buy250k: OrderIntent = { symbol: "NVDA", side: "buy", notionalUsd: 250_000 };
const result = planExecution(buy250k, desk, snap);
const byId = (r: { candidates: StrategyQuote[] }, id: string) => r.candidates.find((c) => c.id === id);

describe("planExecution on the recorded overnight NVDA market", () => {
  it("sizes the order from the rToken arrival mid", () => {
    expect(result.qty).toBeCloseTo(250_000 / mid(must(snap.books.rtoken)), 9);
    expect(result.notionalUsd).toBeCloseTo(250_000, 6);
    expect(result.basisBps).toBeCloseTo(
      (mid(must(snap.books.rtoken)) / mid(must(snap.books.perp)) - 1) * 1e4,
      9,
    );
  });

  it("prices every family and picks the cheapest risk-adjusted feasible plan", () => {
    expect(Object.keys(result.bestByFamily).sort()).toEqual(
      ["immediate", "passive", "perp_then_rotate", "sliced", "wait"].sort(),
    );
    const feasible = result.candidates.filter((c) => c.feasible);
    const minScore = Math.min(...feasible.map((c) => c.score));
    expect(result.best?.score).toBe(minScore);
    for (const [kind, q] of Object.entries(result.bestByFamily)) {
      expect(q?.kind).toBe(kind);
      expect(q?.score).toBe(Math.min(...feasible.filter((c) => c.kind === kind).map((c) => c.score)));
    }
  });

  it("scores each candidate as expected + lambda * sd", () => {
    for (const c of result.candidates)
      expect(c.score).toBeCloseTo(c.expectedBps + LAMBDA.normal * c.sdBps, 10);
  });

  it("returns candidates sorted by score with unique deterministic ids", () => {
    const ids = result.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < result.candidates.length; i++) {
      expect(must(result.candidates[i]).score).toBeGreaterThanOrEqual(must(result.candidates[i - 1]).score);
    }
    expect(planExecution(buy250k, desk, snap)).toEqual(result);
  });

  it("includes the Bitget-app style TWAP-60s baseline", () => {
    const twap = result.baseline;
    expect(twap?.id).toBe("twap60:rtoken:n50");
    expect(twap?.slices).toHaveLength(50);
    expect(twap?.slices.every((s, i) => s.t === snap.now + i * 60_000)).toBe(true);
  });

  it("lowers impact but raises price risk as slices are added", () => {
    const series = [2, 3, 4, 6, 8, 12, 16, 24].map((n) => must(byId(result, `sliced:rtoken:n${n}:t60`)));
    for (let i = 1; i < series.length; i++) {
      expect(must(series[i]).components.impact).toBeLessThanOrEqual(
        must(series[i - 1]).components.impact + 1e-9,
      );
      expect(must(series[i]).components.priceRisk).toBeGreaterThan(
        must(must(series[i - 1]).components.priceRisk),
      );
    }
  });

  it("skips a wait for a session it has no recorded book for, with the reason", () => {
    const skip = result.skipped.find((s) => s.id.startsWith("wait:rtoken:regular"));
    expect(skip?.reason).toMatch(/representative rtoken book for regular/);
    expect(result.candidates.some((c) => c.id.startsWith("wait:rtoken:regular"))).toBe(false);
  });

  it("reports the assumptions it had to make", () => {
    const all = result.candidates.flatMap((c) => c.assumptions).join("\n");
    expect(all).toMatch(/half-life/);
    expect(all).toMatch(/24\/7/);
  });
});

describe("planner invariants", () => {
  it("moves faster as urgency rises", () => {
    const runs = (["patient", "normal", "urgent"] as const).map((urgency) =>
      must(planExecution(buy250k, { ...desk, urgency }, snap).best),
    );
    const [patient, normal, urgent] = runs as [StrategyQuote, StrategyQuote, StrategyQuote];
    expect(patient.sdBps).toBeGreaterThanOrEqual(normal.sdBps);
    expect(normal.sdBps).toBeGreaterThanOrEqual(urgent.sdBps);
    expect(urgent.endsAt - urgent.startsAt).toBeLessThanOrEqual(patient.endsAt - patient.startsAt);
    expect(patient.expectedBps).toBeLessThanOrEqual(urgent.expectedBps);
  });

  it("never emits a perp leg when the profile disallows perps", () => {
    const r = planExecution(buy250k, { ...desk, allowPerp: false }, snap);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.flatMap((c) => c.slices).some((s) => s.venue === "perp")).toBe(false);
    expect(r.bestByFamily.perp_then_rotate).toBeUndefined();
    expect(r.assumptions.join(" ")).toMatch(/perp/);
  });

  it("respects the deadline", () => {
    const deadline = snap.now + 5 * 60_000;
    const r = planExecution({ ...buy250k, deadline }, desk, snap);
    expect(r.best).not.toBeNull();
    expect(must(r.best).endsAt).toBeLessThanOrEqual(deadline);
    for (const c of r.candidates) {
      if (c.endsAt > deadline) expect(c.violations).toContain("DEADLINE");
    }
    expect(r.bestByFamily.wait).toBeUndefined();
  });

  it("restricts venues on request", () => {
    const r = planExecution({ ...buy250k, venues: ["perp"] }, desk, snap);
    expect(r.candidates.flatMap((c) => c.slices).every((s) => s.venue === "perp")).toBe(true);
  });

  it("mirrors the side for sells", () => {
    const r = planExecution({ ...buy250k, side: "sell" }, desk, snap);
    expect(
      must(r.best)
        .slices.filter((s) => s.leg === "entry")
        .every((s) => s.side === "sell"),
    ).toBe(true);
    expect(must(r.best).expectedBps).toBeGreaterThan(0);
  });

  it("flags participation breaches on venues with recorded flow and waives them where nothing prints", () => {
    const r = planExecution(buy250k, { ...desk, maxParticipation: 0.001 }, snap);
    expect(byId(r, "sliced:perp:n6:t60")?.violations).toContain("PARTICIPATION");
    expect(byId(r, "sliced:rtoken:n6:t60")?.violations).not.toContain("PARTICIPATION");
    expect(byId(r, "sliced:rtoken:n6:t60")?.assumptions.join(" ")).toMatch(/participation/);
  });

  it("never picks a plan that exhausts the visible book", () => {
    const r = planExecution({ ...buy250k, notionalUsd: 5_000_000 }, desk, snap);
    expect(byId(r, "immediate:rtoken")?.violations).toContain("BOOK_EXHAUSTED");
    expect(r.best === null || !r.best.violations?.includes("BOOK_EXHAUSTED")).toBe(true);
  });

  it("offers perp_hold only with a hold horizon, charging funding over it", () => {
    expect(result.bestByFamily.perp_hold).toBeUndefined();
    const ah = nvdaSnapshot("after_hours");
    const r = planExecution({ ...buy250k, holdHorizonHours: 24 }, desk, ah);
    const hold = byId(r, "perp_hold:h24:immediate");
    expect(hold?.components.funding).toBeCloseTo(3 * must(ah.funding).rate * 1e4, 10);
  });

  it("avoids an earnings window when the profile asks to", () => {
    const events = [
      {
        kind: "earnings" as const,
        symbol: "NVDA",
        ts: snap.now + 20 * 60_000,
        windowSec: 600,
        label: "NVDA Q3",
        source: "test",
      },
    ];
    const r = planExecution(buy250k, desk, { ...snap, events });
    expect(byId(r, "sliced:rtoken:n24:t60")?.violations).toContain("EVENT_WINDOW");
    expect(must(r.best).violations ?? []).not.toContain("EVENT_WINDOW");
  });

  it("refuses an intent for a different symbol than the market snapshot", () => {
    expect(() => planExecution({ ...buy250k, symbol: "TSLA" }, desk, snap)).toThrow(/TSLA/);
  });

  it("refuses an intent without a size", () => {
    expect(() => planExecution({ symbol: "NVDA", side: "buy" }, desk, snap)).toThrow(/size/);
  });
});

describe("weekend with a rToken that does not trade on weekends", () => {
  const saturday = Date.parse("2026-10-10T16:00:00Z");
  const weekend = nvdaSnapshot("overnight", {
    now: saturday,
    books: {
      rtoken: retime(liveBook("overnight", "rtoken"), saturday - 1000),
      perp: retime(liveBook("overnight", "perp"), saturday - 1000),
    },
    sessions: {
      symbol: "NVDA",
      tradingPeriods: ["pre_market", "regular", "after_hours", "overnight"],
      weekendTradable: false,
    },
  });
  const r = planExecution(buy250k, desk, weekend);

  it("offers no rToken order now, but a wait for Sunday overnight and perp routes", () => {
    expect(r.candidates.some((c) => c.slices.some((s) => s.venue === "rtoken" && s.t === saturday))).toBe(
      false,
    );
    const wait = r.bestByFamily.wait;
    expect(wait?.startsAt).toBe(Date.parse("2026-10-12T00:00:00Z"));
    expect(byId(r, "immediate:perp")).toBeDefined();
    const rotate = r.bestByFamily.perp_then_rotate;
    expect(rotate?.slices.some((s) => s.leg === "rotate_in" && s.venue === "rtoken")).toBe(true);
    expect(rotate?.components.basisRisk).toBeGreaterThan(0);
  });
});

describe("buildPlan", () => {
  it("freezes a chosen candidate into a Plan", () => {
    const plan = buildPlan(result, must(result.best).id);
    expect(plan.strategy).toBe(result.best);
    expect(plan.createdAt).toBe(snap.now);
    expect(plan.profileName).toBe("desk");
    const venue = must(must(result.best).slices[0]).venue;
    expect(plan.arrivalMid).toBe(mid(must(snap.books[venue])));
    expect(plan.sources).toEqual(snap.sources);
  });

  it("rejects an unknown strategy id", () => {
    expect(() => buildPlan(result, "nope")).toThrow(/nope/);
  });
});
