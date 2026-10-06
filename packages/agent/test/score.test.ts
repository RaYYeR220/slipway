import { describe, expect, it } from "vitest";
import { type Check, scoreTurn } from "../eval/score.js";
import type { TurnResult } from "../src/llm/agent.js";
import { renderModelText } from "../src/slots.js";

const THU_0000_NY = Date.UTC(2026, 9, 8, 4, 0);
const NOW = Date.UTC(2026, 9, 6, 6, 30);

function turn(
  text: string,
  calls: { tool: string; input: Record<string, unknown>; intent?: Record<string, unknown>; ok?: boolean }[],
): TurnResult {
  return {
    text,
    rendered: renderModelText(text, {
      "opt1.best.expectedBps": { value: 12.3, unit: "bps", source: "slipway.planner" },
    }),
    draft: null,
    toolCalls: calls.map((c, i) => ({
      tool: c.tool as never,
      input: c.input,
      tag: `t${i}`,
      ok: c.ok ?? true,
    })),
    envelopes: calls.map((c, i) => ({
      tag: `t${i}`,
      tool: c.tool as never,
      ok: c.ok ?? true,
      data: { intent: c.intent },
      slots: {},
      sources: [],
    })),
    conversation: { messages: [], envelopes: [] },
    usage: {} as never,
    steps: 1,
  };
}
const failed = (cs: Check[]) => cs.filter((c) => !c.pass).map((c) => c.name);

describe("LUI answer-key scoring", () => {
  const ctx = { now: NOW, latestVerdict: null, priorVerdict: null };

  it("checks resolved intent fields, tools, slot citations and masked figures", () => {
    const r = turn("Best costs {{opt1.best.expectedBps}}.", [
      {
        tool: "price_options",
        input: {},
        intent: {
          symbol: "NVDA",
          side: "buy",
          notionalUsd: 40_200,
          venues: ["rtoken"],
          urgency: "patient",
          deadline: THU_0000_NY,
        },
      },
    ]);
    const s = scoreTurn(
      {
        calls: { mustInclude: ["price_options"], mustNotInclude: ["issue_tickets"] },
        intent: {
          tool: "price_options",
          symbol: "NVDA",
          side: "buy",
          notionalUsd: 40_000,
          venues: ["rtoken"],
          urgency: "patient",
          deadlineDay: "thursday",
        },
        noNumerals: true,
        citesSlot: ".best.",
      },
      r,
      ctx,
    );
    expect(failed(s.checks)).toEqual([]);
    expect(s.score).toBe(1);
  });

  it("fails wrong fields, typed figures and tickets without an ALLOW plan", () => {
    const r = turn("About 40k, done?", [
      { tool: "price_options", input: {}, intent: { symbol: "NVDA", side: "sell", notionalUsd: 20_000 } },
      { tool: "issue_tickets", input: { planId: "x" } },
    ]);
    const s = scoreTurn(
      {
        intent: { tool: "price_options", side: "buy", notionalUsd: 40_000 },
        noNumerals: true,
        ticketsIffAllow: true,
        clarify: true,
      },
      r,
      ctx,
    );
    expect(failed(s.checks)).toEqual([
      "intent.side",
      "intent.notionalUsd",
      "clarify",
      "noNumerals",
      "ticketsIffAllow",
    ]);
    expect(s.score).toBeCloseTo(1 / 6, 9);
  });

  it("accepts any listed alternative and scores a failed turn as zero", () => {
    const r = turn("Waiting looks worse: {{opt1.best.expectedBps}}.", []);
    const s = scoreTurn(
      { any: [{ calls: { mustInclude: ["price_options"] } }, { citesSlot: ".best." }] },
      r,
      ctx,
    );
    expect(s.score).toBe(1);
    expect(scoreTurn({ noNumerals: true }, null, ctx)).toEqual({
      checks: [{ name: "completed", pass: false }],
      score: 0,
    });
  });
});
