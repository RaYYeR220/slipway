import type { MarketData, OptionsData, PlanData, QuoteView, TideData } from "@slipway/sdk";
import { asSchema, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../src/desk/schemas.js";
import { DeskSession, envelopesFrom, modelView, type ToolEnvelope } from "../src/llm/session.js";
import { deskTools } from "../src/llm/tools.js";
import { formatSlot, renderModelText } from "../src/slots.js";
import { recordedDesk } from "./support/desk.js";

const SLOT_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const ORDER = {
  symbol: "NVDA",
  side: "buy",
  notionalUsd: 40_000,
  deadline: "before thursday",
  venues: ["rtoken"],
  urgency: "patient",
};

type Execute = (
  input: unknown,
  opts: { toolCallId: string; messages: []; context: object },
) => Promise<ToolEnvelope>;
const invoke = (tools: ToolSet, name: string, input: unknown, id = `call-${name}`) =>
  ((tools[name] as { execute: unknown }).execute as Execute)(input, {
    toolCallId: id,
    messages: [],
    context: {},
  });

async function jsonSchemaOf(tools: ToolSet, name: string) {
  return (await asSchema(tools[name]?.inputSchema).jsonSchema) as {
    type: string;
    required?: string[];
    properties: Record<string, { type?: string; enum?: string[]; items?: { enum?: string[] } }>;
  };
}

async function everyTool() {
  const s = new DeskSession(recordedDesk(), DEFAULT_PROFILE);
  const tools = deskTools(s);
  const out = {
    market: await invoke(tools, "market_state", { symbol: "NVDA" }),
    research: await invoke(tools, "research", { symbol: "NVDA" }),
    tide: await invoke(tools, "liquidity_tide", { symbol: "NVDA" }),
    options: await invoke(tools, "price_options", ORDER),
    plan: await invoke(tools, "build_plan", { ...ORDER, strategyId: "best" }),
    explain: await invoke(tools, "explain", { topic: "COST_CAP" }),
    track: await invoke(tools, "track_record", {}),
    profile: await invoke(tools, "get_profile", {}),
    proposal: await invoke(tools, "propose_profile_update", {
      patch: { allowPerp: false },
      reason: "never perps",
    }),
  };
  const tickets = await invoke(tools, "issue_tickets", {
    planId: (out.plan.data as { planId: string }).planId,
  });
  return { s, tools, out: { ...out, tickets } };
}

describe("tool schemas (what the model is offered)", () => {
  it("exposes the ten desk tools with JSON schemas a provider accepts", async () => {
    const tools = deskTools(new DeskSession(recordedDesk(), DEFAULT_PROFILE));
    expect(Object.keys(tools).sort()).toEqual([
      "build_plan",
      "explain",
      "get_profile",
      "issue_tickets",
      "liquidity_tide",
      "market_state",
      "price_options",
      "propose_profile_update",
      "research",
      "track_record",
    ]);
    for (const name of Object.keys(tools)) {
      const js = await jsonSchemaOf(tools, name);
      expect(js.type).toBe("object");
      expect(tools[name]?.description?.length).toBeGreaterThan(40);
    }
    const po = await jsonSchemaOf(tools, "price_options");
    expect(po.required?.sort()).toEqual(["side", "symbol"]);
    expect(po.properties.side?.enum).toEqual(["buy", "sell"]);
    expect(po.properties.urgency?.enum).toEqual(["patient", "normal", "urgent"]);
    expect(po.properties.venues?.items?.enum).toEqual(["rtoken", "perp"]);
    expect(po.properties.deadline?.type).toBe("string");
    expect((await jsonSchemaOf(tools, "build_plan")).required).toContain("strategyId");
    expect((await jsonSchemaOf(tools, "issue_tickets")).required).toEqual(["planId"]);
  });

  it("validates inputs before the desk runs (one size only)", async () => {
    const tools = deskTools(new DeskSession(recordedDesk(), DEFAULT_PROFILE));
    const v = await asSchema(tools.price_options?.inputSchema).validate?.({ ...ORDER, qty: 5 });
    expect(v?.success).toBe(false);
  });
});

describe("envelopes, model views and slot coverage", () => {
  it("tags results per tool, keeps full data for the UI and recovers signed plans by id", async () => {
    const { s, out } = await everyTool();
    expect(out.market.tag).toBe("mkt1");
    expect(out.options.tag).toBe("opt1");
    expect(out.plan.tag).toBe("plan1");
    expect(out.tickets.tag).toBe("tix1");
    expect(out.tickets.ok).toBe(true);
    expect(out.plan.callId).toBe("call-build_plan");
    expect(Object.keys(out.options.slots).every((k) => k.startsWith("opt1."))).toBe(true);
    expect(s.profile.allowPerp).toBe(true); // a proposal never changes the profile by itself
    expect((out.proposal.data as { proposal: { changed: string[] } }).proposal.changed).toEqual([
      "allowPerp",
    ]);

    const resumed = new DeskSession(recordedDesk(), DEFAULT_PROFILE, s.artifacts);
    expect(resumed.nextTag("price_options")).toBe("opt2");
    expect([...resumed.plans.keys()]).toEqual([(out.plan.data as { planId: string }).planId]);
  });

  it("shows the model only slots, ids and source names: no figure outside a slot", async () => {
    const { out } = await everyTool();
    for (const env of Object.values(out)) {
      const view = modelView(env);
      for (const [name, text] of Object.entries(view.slots)) {
        expect(name).toMatch(SLOT_NAME);
        expect(text).toBe(formatSlot(env.slots[name] as never));
      }
      const { slots: _s, planId: _p, tag: _t, error: _e, ...rest } = view;
      expect(JSON.stringify(rest), `${env.tool} view`).not.toMatch(/\p{N}/u);
      if (view.error) expect(env.slots[`${env.tag}.error`]?.value).toBe(view.error);
    }
    expect(JSON.stringify(modelView(out.plan))).not.toMatch(/signedPlan|"sig"/);
  });

  it("every figure the model may cite about a plan is a slot carrying the exact computed value", async () => {
    const { out } = await everyTool();
    const o = out.options.data as OptionsData;
    const view = modelView(out.options).slots;
    const quotes = [["best", o.best], ["baseline", o.baseline], ...Object.entries(o.families)] as [
      string,
      QuoteView,
    ][];
    const fields: [string, keyof QuoteView][] = [
      ["expectedBps", "expectedBps"],
      ["p10", "p10Bps"],
      ["p90", "p90Bps"],
      ["costUsd", "expectedCostUsd"],
    ];
    for (const [scope, q] of quotes) {
      for (const [slot, field] of fields) {
        expect(out.options.slots[`opt1.${scope}.${slot}`]?.value, `${scope}.${slot}`).toBe(q[field]);
        expect(view[`opt1.${scope}.${slot}`], `${scope}.${slot} shown`).toBeDefined();
      }
    }
    expect(out.options.slots["opt1.order.notional"]?.value).toBe(o.notionalUsd);
    expect(out.options.slots["opt1.saving.bps"]?.value).toBe(o.savingVsBaseline?.bps);
    const p = out.plan.data as PlanData;
    expect(out.plan.slots["plan1.plan.expectedBps"]?.value).toBe(p.strategy.expectedBps);
    expect(out.plan.slots["plan1.plan.expires"]?.value).toMatch(/NY$/);
    expect(out.plan.slots["plan1.gate.verdict"]?.value).toBe("ALLOW");
    const m = out.market.data as MarketData;
    expect(out.market.slots["mkt1.rtoken.spread"]?.value).toBe(m.venues.rtoken?.book?.spreadBps);
    expect(out.market.slots["mkt1.funding.rate"]?.value).toBe(m.funding?.rate);
    const t = out.tide.data as TideData;
    expect(out.tide.slots["tide1.now.perp.depth25"]?.value).toBe(t.live.venues.perp?.depth25Usd);
  });

  it("renders a reply that cites every shown slot without a single flag", async () => {
    const { s, out } = await everyTool();
    const names = Object.values(out).flatMap((e) => Object.keys(modelView(e).slots));
    const reply = names.map((n) => `{{${n}}}`).join(" · ");
    const r = renderModelText(reply, s.slots());
    expect(r.flags).toEqual([]);
    expect(r.parts.filter((p) => p.kind === "slot")).toHaveLength(names.length);
    expect(s.render("Fees run {{opt1.best.cost.fees}}, not 10 bp").flags).toEqual([
      { raw: "10", reason: "numeral" },
    ]);
  });

  it("turns tool failures into error envelopes the model can read and cite", async () => {
    const s = new DeskSession(recordedDesk(), DEFAULT_PROFILE);
    const tools = deskTools(s);
    const bad = await invoke(tools, "price_options", { ...ORDER, deadline: "whenever" });
    expect(bad).toMatchObject({ ok: false, tag: "opt1", error: { code: "BAD_INPUT" } });
    const missing = await invoke(tools, "issue_tickets", { planId: "deadbeef0000" });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: expect.stringMatching(/build_plan first/) },
    });
  });

  it("recovers envelopes from AI SDK UI messages sent back by the client", async () => {
    const { out } = await everyTool();
    const ui = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-build_plan",
            toolCallId: "x",
            state: "output-available",
            input: {},
            output: out.plan,
          },
        ],
      },
    ];
    const found = envelopesFrom(ui);
    expect(found).toHaveLength(1);
    expect(new DeskSession(recordedDesk(), DEFAULT_PROFILE, found).plans.size).toBe(1);
  });
});
