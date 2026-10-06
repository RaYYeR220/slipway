import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../src/desk/schemas.js";
import { createApiHandlers } from "../src/http.js";
import { emptyConversation, runTurn, runTurnText } from "../src/llm/agent.js";
import type { ToolEnvelope } from "../src/llm/session.js";
import { NOW, recordedDesk } from "./support/desk.js";

type Step = { tools: { name: string; input: unknown }[] } | { text: string };
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** A model that plays a fixed script, one step per call, and records what it was shown. */
function scripted(steps: Step[]) {
  let i = 0;
  const content = (s: Step, n: number): LanguageModelV4Content[] =>
    "text" in s
      ? [{ type: "text", text: s.text }]
      : s.tools.map((t, k) => ({
          type: "tool-call",
          toolCallId: `c${n}-${k}`,
          toolName: t.name,
          input: JSON.stringify(t.input),
        }));
  const finish = (s: Step) => ({
    unified: "text" in s ? ("stop" as const) : ("tool-calls" as const),
    raw: undefined,
  });
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const s = steps[i++] as Step;
      return { content: content(s, i), finishReason: finish(s), usage, warnings: [] };
    },
    doStream: async () => {
      const s = steps[i++] as Step;
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const c of content(s, i)) {
        if (c.type === "text")
          parts.push(
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: c.text },
            { type: "text-end", id: "t" },
          );
        else parts.push(c as LanguageModelV4StreamPart);
      }
      parts.push({ type: "finish", finishReason: finish(s), usage });
      return {
        stream: new ReadableStream({
          start: (ctl) => {
            for (const p of parts) ctl.enqueue(p);
            ctl.close();
          },
        }),
      };
    },
  });
}

const ORDER = {
  symbol: "NVDA",
  side: "buy",
  notionalUsd: 40_000,
  deadline: "before thursday",
  venues: ["rtoken"],
  urgency: "patient",
};

const toolResults = (call: LanguageModelV4CallOptions | undefined) =>
  (call?.prompt ?? [])
    .flatMap((m: LanguageModelV4CallOptions["prompt"][number]) => (m.role === "tool" ? m.content : []))
    .filter((p: { type: string }) => p.type === "tool-result");

describe("runTurnText (non-streaming loop with a scripted model)", () => {
  it("prices, plans and renders a reply whose figures all come from slots", async () => {
    const model = scripted([
      { tools: [{ name: "price_options", input: ORDER }] },
      { tools: [{ name: "build_plan", input: { ...ORDER, strategyId: "best" } }] },
      {
        text: "Best: {{opt1.best.label}} at {{opt1.best.expectedBps}} ({{opt1.best.p10}} to {{opt1.best.p90}}). Plan {{plan1.plan.planId}} is {{plan1.gate.verdict}}. About 40k, {{opt9.best.p10}}.",
      },
      {
        text: "Best: {{opt1.best.label}} at {{opt1.best.expectedBps}}. Plan {{plan1.plan.planId}} is {{plan1.gate.verdict}} for {{opt1.order.notional}}.",
      },
    ]);
    const r = await runTurnText(
      emptyConversation(),
      "I want $40k of NVDA before Thursday, no perps, I'm patient",
      DEFAULT_PROFILE,
      {
        desk: recordedDesk(),
        model,
        now: () => NOW,
      },
    );
    expect(r.toolCalls.map((c) => [c.tool, c.tag, c.ok])).toEqual([
      ["price_options", "opt1", true],
      ["build_plan", "plan1", true],
    ]);
    expect(r.toolCalls[0]?.input).toMatchObject({
      symbol: "NVDA",
      notionalUsd: 40_000,
      venues: ["rtoken"],
      urgency: "patient",
    });
    // The draft typed a figure and cited a slot that does not exist; the desk sent it back once.
    expect(r.draft?.flags).toEqual([
      { raw: "40k", reason: "numeral" },
      { raw: "{{opt9.best.p10}}", reason: "unknown-slot" },
    ]);
    const note = model.doGenerateCalls[3]?.prompt.at(-1);
    expect(JSON.stringify(note)).toMatch(/desk check.*40k.*opt9\.best\.p10/);
    expect(r.rendered.flags).toEqual([]);
    expect(r.rendered.text).toMatch(
      /^Best: 4 slices every 60s on rNVDA at \d+\.\d bp\. Plan [0-9a-f]{12} is ALLOW for \$40,000\.$/,
    );
    expect(r.steps).toBe(4);

    // The model was shown the compact view (slots + ids), never the signed plan.
    const seen = toolResults(model.doGenerateCalls[2]);
    expect(seen).toHaveLength(2);
    const planOut = JSON.stringify(seen[1]);
    expect(planOut).toMatch(/plan1\.gate\.verdict/);
    expect(planOut).not.toMatch(/signedPlan|"sig"/);
    expect(model.doGenerateCalls[0]?.prompt[0]).toMatchObject({ role: "system" });
  });

  it("shows a masked draft as masked when repair is off", async () => {
    const r = await runTurnText(emptyConversation(), "hi", DEFAULT_PROFILE, {
      desk: recordedDesk(),
      model: scripted([{ text: "Costs about 12 bp." }]),
      repair: false,
    });
    expect(r.draft).toBeNull();
    expect(r.rendered.text).toBe("Costs about [unverified] bp.");
  });

  it("issues tickets in a later turn from the plan id alone, via the plan carried in the conversation", async () => {
    const desk = recordedDesk();
    const first = await runTurnText(emptyConversation(), "price and plan it", DEFAULT_PROFILE, {
      desk,
      model: scripted([
        { tools: [{ name: "build_plan", input: { ...ORDER, strategyId: "best" } }] },
        { text: "Plan {{plan1.plan.planId}}: {{plan1.gate.verdict}}." },
      ]),
    });
    const planId = (first.envelopes[0] as ToolEnvelope<{ planId: string }>).data?.planId as string;
    const second = await runTurnText(first.conversation, "confirmed, send tickets", DEFAULT_PROFILE, {
      desk,
      model: scripted([
        { tools: [{ name: "issue_tickets", input: { planId } }] },
        { text: "{{tix1.tickets.count}} dry-run tickets ready." },
      ]),
    });
    expect(second.toolCalls).toEqual([{ tool: "issue_tickets", input: { planId }, tag: "tix1", ok: true }]);
    expect(second.rendered.text).toBe("4 dry-run tickets ready.");
    expect(second.conversation.envelopes.map((e) => e.tag)).toEqual(["plan1", "tix1"]);
  });
});

async function readUiStream(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

describe("runTurn (web route, AI SDK UI message stream)", () => {
  it("streams tool envelopes for the UI and ends with the rendered text", async () => {
    const res = await runTurn(
      {
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "price $40k NVDA, patient, no perps" }] },
        ] as UIMessage[],
      },
      {
        desk: recordedDesk(),
        model: scripted([
          { tools: [{ name: "price_options", input: ORDER }] },
          { text: "Best costs {{opt1.best.expectedBps}}." },
        ]),
        now: () => NOW,
      },
    );
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const chunks = await readUiStream(res);
    const output = chunks.find((c) => c.type === "tool-output-available")?.output as ToolEnvelope;
    expect(output).toMatchObject({ tag: "opt1", tool: "price_options", ok: true });
    expect((output.data as { best: { id: string } }).best.id).toBe("sliced:rtoken:n4:t60");
    const render = chunks.find((c) => c.type === "data-render")?.data as { text: string; ok: boolean };
    expect(render.ok).toBe(true);
    expect(render.text).toMatch(/^Best costs \d+\.\d bp\.$/);
    expect(chunks.at(-1)?.type).toBe("finish");
  });

  it("streams one rewrite after a masked draft, and renders the rewrite", async () => {
    const res = await runTurn(
      {
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "explain wait" }] },
        ] as UIMessage[],
      },
      {
        desk: recordedDesk(),
        model: scripted([
          { tools: [{ name: "explain", input: { topic: "wait" } }] },
          { text: "It skips the first 15 minutes." },
          { text: "It skips the first {{ex1.explain.openSkipMinutes}} minutes." },
        ]),
      },
    );
    const chunks = await readUiStream(res);
    const repair = chunks.find((c) => c.type === "data-repair") as { data: { flags: { raw: string }[] } };
    expect(repair.data.flags.map((f) => f.raw)).toEqual(["15"]);
    const render = chunks.find((c) => c.type === "data-render") as { data: { text: string; ok: boolean } };
    expect(render.data).toMatchObject({ ok: true, text: "It skips the first 15 minutes." });
    expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
    expect(chunks.at(-1)?.type).toBe("finish");
  });

  it("continues from client-held UI messages: a plan from an earlier turn is ticketed by id", async () => {
    const desk = recordedDesk();
    const plan = await desk.buildPlan(ORDER as never, DEFAULT_PROFILE, "best");
    const envelope: ToolEnvelope = {
      tag: "plan1",
      tool: "build_plan",
      ok: true,
      data: plan.data,
      slots: {},
      sources: [],
    };
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "plan it" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-build_plan",
            toolCallId: "p1",
            state: "output-available",
            input: { ...ORDER, strategyId: "best" },
            output: envelope,
          },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "confirmed" }] },
    ] as unknown as UIMessage[];
    const res = await runTurn(
      { messages },
      {
        desk,
        model: scripted([
          { tools: [{ name: "issue_tickets", input: { planId: plan.data.planId } }] },
          { text: "Done: {{tix1.tickets.status}}." },
        ]),
      },
    );
    const chunks = await readUiStream(res);
    const out = chunks.find((c) => c.type === "tool-output-available")?.output as ToolEnvelope;
    expect(out).toMatchObject({ tag: "tix1", ok: true });
    const render = chunks.find((c) => c.type === "data-render") as { data: { text: string } };
    expect(render.data.text).toBe("Done: ISSUED (dry run).");
  });
});

describe("POST /api/chat", () => {
  it("validates the body, then streams the turn through the same agent", async () => {
    const api = createApiHandlers(recordedDesk(), {
      model: scripted([
        { tools: [{ name: "explain", input: { topic: "wait" } }] },
        { text: "Waiting skips {{ex1.explain.openSkipMinutes}} of the open." },
      ]),
    });
    const bad = await api.chat(
      new Request("http://slipway.test/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: "hi" }),
      }),
    );
    expect(bad.status).toBe(400);
    const res = await api.dispatch(
      new Request("http://slipway.test/api/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "what is wait?" }] }],
        }),
      }),
    );
    const render = (await readUiStream(res)).find((c) => c.type === "data-render") as {
      data: { text: string };
    };
    expect(render.data.text).toBe("Waiting skips 15 of the open.");
  });
});
