import { describe, expect, it } from "vitest";
import { mid, shiftBook } from "../src/book.js";
import { priceSchedule } from "../src/cost.js";
import { type GateInput, largestQtyUnderCap, runGate, scheduleFromSlices } from "../src/gate.js";
import { buildPlan, planExecution } from "../src/planner.js";
import type { GateCode, MarketSnapshot, OrderIntent, Plan, Profile } from "../src/types.js";
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
const intent: OrderIntent = { symbol: "NVDA", side: "buy", notionalUsd: 250_000 };

function planFor(id: string, i: OrderIntent = intent, s: MarketSnapshot = snap, p: Profile = desk): Plan {
  return buildPlan(planExecution(i, p, s), id);
}

function gate(plan: Plan, patch: Partial<GateInput> = {}) {
  return runGate({ plan, snapshot: snap, profile: desk, now: snap.now, ...patch });
}

const check = (r: ReturnType<typeof gate>, code: GateCode) => must(r.checks.find((c) => c.code === code));

describe("runGate — allow path", () => {
  it("passes every check for a fresh, affordable perp market order", () => {
    const r = gate(planFor("immediate:perp"));
    expect(r.verdict).toBe("allow");
    expect(r.checks.map((c) => c.code)).toEqual([
      "DATA_STALE",
      "VENUE_CLOSED",
      "BOOK_EXHAUSTED",
      "COST_CAP",
      "PARTICIPATION",
      "EVENT_WINDOW",
      "PRICE_INTEGRITY",
      "PROFILE",
      "DEADLINE",
      "SOURCE_MISSING",
    ]);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("is deterministic", () => {
    const plan = planFor("sliced:rtoken:n6:t60");
    expect(gate(plan)).toEqual(gate(plan));
  });
});

describe("runGate — refusals and holds", () => {
  it("DATA_STALE: refuses when the live book used by a now-leg is older than 10 s", () => {
    const plan = planFor("immediate:perp");
    const stale = {
      ...snap,
      books: { ...snap.books, perp: retime(must(snap.books.perp), snap.now - 11_000) },
    };
    const r = gate(plan, { snapshot: stale });
    expect(r.verdict).toBe("refuse");
    expect(check(r, "DATA_STALE")).toMatchObject({
      status: "refuse",
      fix: expect.stringMatching(/refresh/i),
    });
  });

  it("DATA_STALE: refuses a plan priced more than 60 s ago", () => {
    const plan = planFor("immediate:perp");
    const later = snap.now + 61_000;
    const fresh = {
      ...snap,
      now: later,
      books: {
        rtoken: retime(must(snap.books.rtoken), later - 500),
        perp: retime(must(snap.books.perp), later - 500),
      },
    };
    const r = gate(plan, { snapshot: fresh, now: later });
    expect(check(r, "DATA_STALE")).toMatchObject({
      status: "refuse",
      fix: expect.stringMatching(/re-plan/i),
    });
  });

  it("VENUE_CLOSED: refuses an rToken leg in a session the rToken does not trade", () => {
    const saturday = Date.parse("2026-10-10T16:00:00Z");
    const books = {
      rtoken: retime(liveBook("overnight", "rtoken"), saturday - 1000),
      perp: retime(liveBook("overnight", "perp"), saturday - 1000),
    };
    const weekendOpen = nvdaSnapshot("overnight", { now: saturday, books });
    const plan = planFor("immediate:rtoken", intent, weekendOpen);
    const closed = { ...weekendOpen, sessions: { ...weekendOpen.sessions, weekendTradable: false } };
    const r = gate(plan, { snapshot: closed, now: saturday });
    expect(check(r, "VENUE_CLOSED")).toMatchObject({
      status: "refuse",
      fix: expect.stringMatching(/overnight/),
    });
    expect(r.verdict).toBe("refuse");
  });

  it("BOOK_EXHAUSTED: refuses a slice larger than visible depth", () => {
    const plan = planFor("immediate:rtoken", { ...intent, notionalUsd: 5_000_000 });
    const r = gate(plan, { profile: { ...desk, costCapBps: 1000 } });
    expect(check(r, "BOOK_EXHAUSTED").status).toBe("refuse");
  });

  it("COST_CAP: refuses above the cap and suggests the largest size and a cheaper strategy under it", () => {
    const tight = { ...desk, costCapBps: 12 };
    const result = planExecution(intent, tight, snap);
    const plan = buildPlan(result, "immediate:rtoken");
    const r = gate(plan, { profile: tight, candidates: result.candidates });
    const c = check(r, "COST_CAP");
    expect(c.status).toBe("refuse");
    expect(c.fix).toMatch(/immediate:perp/);
    expect(r.verdict).toBe("refuse");
  });

  it("COST_CAP: says so when fees alone exceed the cap", () => {
    const r = gate(planFor("immediate:rtoken"), { profile: { ...desk, costCapBps: 5 } });
    expect(check(r, "COST_CAP").fix).toMatch(/no size/i);
  });

  it("PARTICIPATION: refuses children that are too large a share of recorded flow", () => {
    const thin = { ...desk, maxParticipation: 0.001 };
    const plan = planFor("sliced:perp:n6:t60", intent, snap, thin);
    const r = gate(plan, { profile: thin });
    expect(check(r, "PARTICIPATION")).toMatchObject({
      status: "refuse",
      fix: expect.stringMatching(/apart|smaller/),
    });
  });

  it("PARTICIPATION: passes but says the cap is waived where nothing printed", () => {
    const r = gate(planFor("sliced:rtoken:n6:t60"));
    expect(check(r, "PARTICIPATION")).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/waived|no recorded prints/),
    });
  });

  it("PARTICIPATION: does not pretend to cap a single order", () => {
    const r = gate(planFor("immediate:perp"));
    expect(check(r, "PARTICIPATION")).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/single/),
    });
  });

  it("EVENT_WINDOW: holds when earnings fall inside the execution window", () => {
    const plan = planFor("sliced:rtoken:n12:t300");
    const events = [
      {
        kind: "earnings" as const,
        symbol: "NVDA",
        ts: snap.now + 30 * 60_000,
        windowSec: 900,
        label: "NVDA Q3",
        source: "bitget-mcp",
      },
    ];
    const r = gate(plan, { snapshot: { ...snap, events } });
    expect(check(r, "EVENT_WINDOW")).toMatchObject({
      status: "hold",
      fix: expect.stringMatching(/before|after/),
    });
    expect(r.verdict).toBe("hold");
  });

  it("PRICE_INTEGRITY: holds when the perp index components disagree by more than 25 bps", () => {
    const px = mid(must(snap.books.perp));
    const indexComponents = [
      { source: "a", price: px, weight: 0.2 },
      { source: "b", price: px * 1.003, weight: 0.2 },
      { source: "c", price: px, weight: 0.6 },
    ];
    const r = gate(planFor("immediate:perp"), { snapshot: { ...snap, indexComponents } });
    expect(check(r, "PRICE_INTEGRITY").status).toBe("hold");
    expect(r.verdict).toBe("hold");
  });

  it("PRICE_INTEGRITY: holds when rToken and perp mids diverge by more than 75 bps", () => {
    const rtoken = shiftBook(must(snap.books.rtoken), mid(must(snap.books.perp)) * 1.01);
    const r = gate(planFor("immediate:perp"), { snapshot: { ...snap, books: { ...snap.books, rtoken } } });
    expect(check(r, "PRICE_INTEGRITY")).toMatchObject({
      status: "hold",
      detail: expect.stringMatching(/bps/),
    });
  });

  it("PROFILE: refuses perp legs the profile no longer allows and avoided sessions", () => {
    const plan = planFor("immediate:perp");
    expect(check(gate(plan, { profile: { ...desk, allowPerp: false } }), "PROFILE").status).toBe("refuse");
    expect(check(gate(plan, { profile: { ...desk, avoidSessions: ["overnight"] } }), "PROFILE").status).toBe(
      "refuse",
    );
    expect(check(gate(plan, { profile: { ...desk, maxLeverage: 0.5 } }), "PROFILE").status).toBe("refuse");
  });

  it("SOURCE_MISSING: refuses when a venue's live book is gone", () => {
    const r = gate(planFor("immediate:perp"), {
      snapshot: { ...snap, books: { rtoken: must(snap.books.rtoken) } },
    });
    expect(check(r, "SOURCE_MISSING").status).toBe("refuse");
    expect(check(r, "COST_CAP").status).toBe("refuse"); // cannot be evaluated, so it cannot pass
  });

  it("SOURCE_MISSING: refuses when a critical feed reports unavailable", () => {
    const sources = snap.sources.map((s) =>
      s.id === "bitget.reality.session"
        ? { ...s, status: "unavailable" as const, since: snap.now - 60_000 }
        : s,
    );
    const r = gate(planFor("immediate:perp"), { snapshot: { ...snap, sources } });
    expect(check(r, "SOURCE_MISSING")).toMatchObject({
      status: "refuse",
      detail: expect.stringMatching(/session/),
    });
  });

  it("re-prices the plan instead of trusting its numbers", () => {
    const plan = planFor("immediate:rtoken");
    const forged: Plan = { ...plan, strategy: { ...plan.strategy, expectedBps: 1 } };
    expect(check(gate(forged, { profile: { ...desk, costCapBps: 12 } }), "COST_CAP").status).toBe("refuse");
  });

  it("lets refuse dominate hold", () => {
    const events = [
      {
        kind: "earnings" as const,
        symbol: "NVDA",
        ts: snap.now,
        windowSec: 600,
        label: "NVDA Q3",
        source: "x",
      },
    ];
    const r = gate(planFor("immediate:rtoken"), {
      snapshot: { ...snap, events },
      profile: { ...desk, costCapBps: 5 },
    });
    expect(check(r, "EVENT_WINDOW").status).toBe("hold");
    expect(r.verdict).toBe("refuse");
  });
});

describe("largestQtyUnderCap", () => {
  it("finds the boundary size by bisection on the real book", () => {
    const plan = planFor("immediate:rtoken", { ...intent, notionalUsd: 1_000_000 });
    const schedule = scheduleFromSlices(plan);
    const cap = 15;
    const q = largestQtyUnderCap(schedule, snap, cap, {});
    expect(q).not.toBeNull();
    const price = (x: number) => {
      const s = { ...schedule, parentQty: x, entry: schedule.entry.map((e) => ({ ...e, qty: x })) };
      const r = priceSchedule(s, snap, {});
      return r.ok ? r.estimate.expectedBps : Number.NaN;
    };
    expect(price(must(q))).toBeLessThanOrEqual(cap);
    expect(price(must(q) * 1.01)).toBeGreaterThan(cap);
  });
});

describe("DEADLINE", () => {
  it("refuses a plan whose last slice lands after the deadline and names one that fits", async () => {
    const { planExecution, buildPlan } = await import("../src/planner.js");
    const { runGate } = await import("../src/gate.js");
    const { nvdaSnapshot } = await import("./market.js");
    const snap = nvdaSnapshot("overnight");
    const profile = {
      name: "t",
      urgency: "patient" as const,
      costCapBps: 1000,
      maxParticipation: 1,
      allowPerp: true,
      maxLeverage: 1,
      avoidSessions: [],
      avoidEvents: false,
    };
    const deadline = snap.now + 10 * 60_000;
    const intent = { symbol: "NVDA", side: "buy" as const, notionalUsd: 250_000, deadline };
    const result = planExecution(intent, profile, snap);
    const late = result.candidates.find((c) => c.slices.some((s) => s.t > deadline));
    if (!late) throw new Error("expected at least one strategy running past ten minutes");
    const gate = runGate({ plan: buildPlan(result, late.id), snapshot: snap, profile, now: snap.now, candidates: result.candidates });
    const check = gate.checks.find((c) => c.code === "DEADLINE");
    expect(check?.status).toBe("refuse");
    expect(check?.fix).toMatch(/finishes in time|move the deadline/);
    expect(gate.verdict).toBe("refuse");
  });
});
