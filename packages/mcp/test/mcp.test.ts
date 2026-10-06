import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Desk } from "@slipway/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordedDeskOptions } from "../../agent/test/support/desk.js";
import { createSlipwayMcpHandler, PLAN_CARD_HTML, PLAN_CARD_URI } from "../src/index.js";

// The handler is exercised exactly as a Next.js route would: web Request in, Response out.
const handler = createSlipwayMcpHandler({ desk: new Desk(recordedDeskOptions() as never) });
const fetchViaHandler = (url: string | URL, init?: RequestInit) => handler.fetch(new Request(url, init));
const client = new Client({ name: "slipway-test", version: "0.0.0" });
const ORDER = {
  symbol: "NVDA",
  side: "buy",
  notionalUsd: 40_000,
  venues: ["rtoken"],
  urgency: "patient",
  deadline: "before thursday",
};

type Structured<T> = {
  data: T;
  slots: Record<string, { value: unknown; unit: string; source: string }>;
  sources: { id: string; status: string }[];
};

beforeAll(async () => {
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://slipway.test/api/mcp"), { fetch: fetchViaHandler }),
  );
});
afterAll(async () => {
  await client.close();
  await handler.close();
});

describe("Slipway MCP server over Streamable HTTP (v2 SDK, in-process round trip)", () => {
  it("identifies itself and lists read-only tools with output schemas and the plan-card UI link", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "slipway", version: "0.1.0" });
    expect(client.getInstructions()).toMatch(
      /issue_tickets with the returned signedPlan only when the verdict is ALLOW/,
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "build_plan",
      "explain",
      "issue_tickets",
      "liquidity_tide",
      "market_state",
      "price_options",
      "research",
      "track_record",
    ]);
    for (const t of tools) {
      expect(t.outputSchema?.type, t.name).toBe("object");
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
    }
    const plan = tools.find((t) => t.name === "build_plan");
    expect(plan?._meta).toMatchObject({ ui: { resourceUri: PLAN_CARD_URI } });
    expect(plan?.inputSchema.required).toEqual(expect.arrayContaining(["symbol", "side", "strategyId"]));
  });

  it("prices, signs and tickets an order; the signed plan survives the JSON round trip", async () => {
    const opt = await client.callTool({ name: "price_options", arguments: ORDER });
    expect(opt.isError).toBeFalsy();
    const o = opt.structuredContent as Structured<{ best: { id: string }; gate: { verdict: string } }>;
    expect(o.data.best.id).toBe("sliced:rtoken:n4:t60");
    expect(o.data.gate.verdict).toBe("allow");
    expect(o.slots["best.expectedBps"]).toMatchObject({ unit: "bps", source: "slipway.planner" });
    expect((opt.content as { text: string }[])[0]?.text).toMatch(
      /^Best: 4 slices every 60s on rNVDA \[sliced:rtoken:n4:t60\]/,
    );

    const built = await client.callTool({
      name: "build_plan",
      arguments: { ...ORDER, strategyId: o.data.best.id },
    });
    const p = built.structuredContent as Structured<{
      planId: string;
      verdict: string;
      signedPlan: object;
      slices: unknown[];
    }>;
    expect(p.data.verdict).toBe("allow");
    expect(p.data.slices).toHaveLength(4);

    const t = await client.callTool({ name: "issue_tickets", arguments: { signedPlan: p.data.signedPlan } });
    const tk = t.structuredContent as Structured<{ ok: boolean; tickets: { bgc: string }[] }>;
    expect(tk.data.ok).toBe(true);
    expect(tk.data.tickets.map((x) => x.bgc)).toHaveLength(4);
    expect((t.content as { text: string }[])[0]?.text).toMatch(
      /4 dry-run ticket\(s\) for plan [0-9a-f]{12} \(nothing sent\)/,
    );
  });

  it("refuses tickets for a REFUSE plan and for a tampered plan, with the fix in the result", async () => {
    const strict = {
      name: "strict",
      urgency: "normal",
      costCapBps: 5,
      maxParticipation: 0.1,
      allowPerp: true,
      maxLeverage: 1,
      avoidSessions: [],
      avoidEvents: true,
    };
    const built = await client.callTool({
      name: "build_plan",
      arguments: { ...ORDER, urgency: "normal", strategyId: "best", profile: strict },
    });
    const p = built.structuredContent as Structured<{
      verdict: string;
      signedPlan: { gate: { verdict: string } };
    }>;
    expect(p.data.verdict).toBe("refuse");
    expect((built.content as { text: string }[])[0]?.text).toMatch(/COST_CAP refuse: .* — fix: /);
    const refused = await client.callTool({
      name: "issue_tickets",
      arguments: { signedPlan: p.data.signedPlan },
    });
    expect((refused.structuredContent as Structured<{ ok: boolean; reason: string }>).data).toMatchObject({
      ok: false,
      reason: "not ticketable: gate verdict is refuse",
    });
    const forged = structuredClone(p.data.signedPlan);
    forged.gate.verdict = "allow";
    const tampered = await client.callTool({ name: "issue_tickets", arguments: { signedPlan: forged } });
    expect((tampered.structuredContent as Structured<{ ok: boolean; reason: string }>).data.reason).toMatch(
      /hash mismatch|contradicts/,
    );
  });

  it("reports invalid input as a tool error and explains topics", async () => {
    const bad = await client.callTool({
      name: "price_options",
      arguments: { ...ORDER, deadline: "eventually" },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]?.text).toMatch(/^BAD_INPUT: cannot read deadline/);
    const ex = await client.callTool({ name: "explain", arguments: { topic: "PARTICIPATION" } });
    expect((ex.content as { text: string }[])[0]?.text).toMatch(/^Participation: /);
  });

  it("serves the MCP Apps plan card: self-contained HTML that renders with text nodes only", async () => {
    const r = await client.readResource({ uri: PLAN_CARD_URI });
    const c = r.contents[0] as { uri: string; mimeType: string; text: string };
    expect(c).toMatchObject({ uri: PLAN_CARD_URI, mimeType: "text/html;profile=mcp-app" });
    expect(c.text).toBe(PLAN_CARD_HTML);
    expect(c.text).toMatch(/"ui\/initialize"/);
    expect(c.text).toMatch(/ui\/notifications\/tool-result/);
    expect(c.text).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|<script src|<link /,
    );
  });

  it("also answers 2025-era clients through the stateless fallback", async () => {
    const res = await handler.fetch(
      new Request("http://slipway.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy", version: "1" },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/"serverInfo":\{"name":"slipway"/);
    expect(body).toMatch(/"protocolVersion":"2025-06-18"/);
  });
});
