import { describe, expect, it } from "vitest";
import { chainForecasts, forecastsFromPlan, GENESIS_PREV, verifyChain } from "../src/ledger.js";
import { buildPlan, planExecution } from "../src/planner.js";
import { generateSigningKeys, signPlan } from "../src/sign.js";
import { runGate } from "../src/gate.js";
import type { Profile } from "../src/types.js";
import { nvdaSnapshot } from "./market.js";

const profile: Profile = {
  name: "test",
  urgency: "patient",
  costCapBps: 1000,
  maxParticipation: 0.2,
  allowPerp: true,
  maxLeverage: 1,
  avoidSessions: [],
  avoidEvents: false,
};

async function signedPlan() {
  const snap = nvdaSnapshot("overnight");
  const result = planExecution({ symbol: "NVDA", side: "buy", notionalUsd: 250_000 }, profile, snap);
  const best = result.best;
  if (!best) throw new Error("no plan");
  const plan = buildPlan(result, best.id);
  const gate = runGate({ plan, snapshot: snap, profile, now: snap.now });
  return signPlan(plan, gate, await generateSigningKeys(), snap.now);
}

describe("forecast ledger", () => {
  it("derives one order-level forecast with its band and one per firm slice", async () => {
    const signed = await signedPlan();
    const bodies = forecastsFromPlan(signed, "trader", signed.issuedAt);
    const order = bodies[0];
    expect(order?.scope).toBe("order");
    expect(order?.predicted).toEqual({
      p50: signed.plan.strategy.expectedBps,
      p10: signed.plan.strategy.p10Bps,
      p90: signed.plan.strategy.p90Bps,
    });
    const firm = signed.plan.strategy.slices.filter((s) => !s.conditional).length;
    expect(bodies.filter((b) => b.scope === "slice")).toHaveLength(firm);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(bodies.length);
  });

  it("chains entries and detects any edit", async () => {
    const signed = await signedPlan();
    const bodies = forecastsFromPlan(signed, "eval", signed.issuedAt);
    const chain = await chainForecasts(GENESIS_PREV, [...bodies, ...bodies.map((b) => ({ ...b, id: `${b.id}:again` }))]);
    expect(chain.length).toBeGreaterThanOrEqual(4);
    expect(await verifyChain(chain)).toBe(-1);

    const tampered = chain.map((e) => ({ ...e }));
    const victim = tampered[1];
    if (!victim) throw new Error("chain too short");
    victim.predicted = { p50: victim.predicted.p50 - 1 };
    expect(await verifyChain(tampered)).toBe(1);

    const dropped = [chain[0], ...chain.slice(2)].filter((e) => e !== undefined);
    expect(await verifyChain(dropped)).toBe(1);
  });
});
