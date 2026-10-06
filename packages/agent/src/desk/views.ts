// Compact, UI- and model-friendly projections of planner/gate objects, and the slots that expose their figures.
import type { GateResult, Slice, StrategyQuote } from "@slipway/core";
import type { CheckView, QuoteView, SliceView } from "@slipway/sdk";
import { nyText, type SlotBag } from "./slots.js";

export type { CheckView, QuoteView, SliceView };

export const PLANNER = "slipway.planner";
export const GATE = "slipway.gate";

export function quoteView(q: StrategyQuote): QuoteView {
  return {
    id: q.id,
    kind: q.kind,
    label: q.label,
    feasible: q.feasible !== false,
    violations: q.violations ?? [],
    expectedBps: q.expectedBps,
    sdBps: q.sdBps,
    p10Bps: q.p10Bps,
    p90Bps: q.p90Bps,
    score: q.score,
    qty: q.qty,
    notionalUsd: q.notionalUsd,
    expectedCostUsd: (q.expectedBps / 1e4) * q.notionalUsd,
    components: q.components,
    startsAt: q.startsAt,
    endsAt: q.endsAt,
    startsNy: nyText(q.startsAt),
    endsNy: nyText(q.endsAt),
    venues: [...new Set(q.slices.map((s) => s.venue))].sort(),
    sessions: [...new Set(q.slices.map((s) => s.session))],
    sliceCount: q.slices.length,
    assumptions: q.assumptions,
  };
}

/** Slots for one strategy quote; every figure in QuoteView the model may cite is here. */
export function quoteSlots(bag: SlotBag, q: QuoteView): void {
  bag
    .text("id", q.id, PLANNER)
    .text("label", q.label, PLANNER)
    .text("kind", q.kind, PLANNER)
    .bps("expectedBps", q.expectedBps, PLANNER)
    .bps("sd", q.sdBps, PLANNER)
    .bps("p10", q.p10Bps, PLANNER)
    .bps("p90", q.p90Bps, PLANNER)
    .usd("costUsd", q.expectedCostUsd, PLANNER)
    .usd("notional", q.notionalUsd, PLANNER)
    .qty("qty", q.qty, PLANNER)
    .time("starts", q.startsAt, PLANNER)
    .time("ends", q.endsAt, PLANNER)
    .count("slices", q.sliceCount, PLANNER)
    .text("venues", q.venues.join(" + "), PLANNER)
    .text("sessions", q.sessions.join(", "), PLANNER)
    .text("violations", q.violations.length ? q.violations.join(", ") : "none", PLANNER);
  const c = q.components;
  const comp = bag.scope("cost");
  comp
    .bps("spread", c.spread, PLANNER)
    .bps("impact", c.impact, PLANNER)
    .bps("fees", c.fees, PLANNER, 1, true)
    .bps("funding", c.funding, PLANNER, 1, true)
    .bps("gapRisk", c.gapRisk, PLANNER)
    .bps("basisRisk", c.basisRisk, PLANNER)
    .bps("nonFill", c.nonFill, PLANNER)
    .bps("priceRisk", c.priceRisk, PLANNER);
}

export function gateSlots(bag: SlotBag, gate: GateResult): void {
  bag.text("verdict", gate.verdict.toUpperCase(), GATE);
  const blocking = gate.checks.filter((c) => c.status !== "pass");
  bag.count("blocking", blocking.length, GATE);
  for (const c of gate.checks) {
    const s = bag.scope(c.code);
    s.text("status", c.status, GATE).text("detail", c.detail, GATE);
    if (c.fix) s.text("fix", c.fix, GATE);
  }
}

export const sliceViews = (slices: Slice[]): SliceView[] =>
  slices.map((s, index) => ({
    index,
    t: s.t,
    ny: nyText(s.t),
    venue: s.venue,
    side: s.side,
    qty: s.qty,
    type: s.type,
    limitPx: s.limitPx ?? null,
    session: s.session,
    expectedBps: s.expectedBps,
    leg: s.leg ?? "entry",
    conditional: s.conditional === true,
  }));
