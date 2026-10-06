// Slipway as an MCP server: the desk's read-only and dry-run tools, with structured output and an MCP Apps plan card.
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  DEFAULT_PROFILE,
  Desk,
  DeskError,
  type DeskResult,
  IntentFields,
  ProfileSchema,
  StrategyIdSchema,
  SymbolSchema,
  TOOL_DESCRIPTIONS,
  TOPICS,
} from "@slipway/agent";
import type { CheckView, ExplainData, OptionsData, PlanData, QuoteView, TicketsData } from "@slipway/sdk";
import { z } from "zod";
import { PLAN_CARD_HTML, PLAN_CARD_URI } from "./plan-card.js";

export const SERVER_INFO = { name: "slipway", version: "0.1.0" };

export const INSTRUCTIONS = `Slipway is an execution desk for Bitget tokenized US stocks (rTokens R<TICKER>USDT and USDT-M stock perps). Use it after the trader has decided what to trade, to decide how: call price_options with the order, present the best plan against the TWAP baseline, call build_plan for the chosen strategy (it is gated and Ed25519-signed), and call issue_tickets with the returned signedPlan only when the verdict is ALLOW and the trader has confirmed. Tickets are dry runs built by Bitget's agent SDK; nothing is sent. A HOLD or REFUSE verdict comes with the failed check and its fix. Every figure in a result is computed by code from Bitget data; sources that were unavailable are listed.`;

const SlotSchema = z.object({
  value: z.union([z.number(), z.string()]),
  unit: z.enum(["bps", "usd", "pct", "count", "qty", "price", "seconds", "text"]),
  dp: z.number().optional(),
  signed: z.boolean().optional(),
  source: z.string(),
});
const SourceSchema = z.looseObject({
  id: z.string(),
  status: z.enum(["live", "cached", "unavailable"]),
  asOf: z.number().nullable(),
});
const QuoteSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  feasible: z.boolean(),
  expectedBps: z.number(),
  sdBps: z.number(),
  p10Bps: z.number(),
  p90Bps: z.number(),
  expectedCostUsd: z.number(),
  startsAt: z.number(),
  endsAt: z.number(),
  sliceCount: z.number(),
});
const CheckSchema = z.looseObject({
  code: z.string(),
  status: z.string(),
  detail: z.string(),
  fix: z.string().optional(),
});

const envelope = <T extends z.ZodType>(data: T) =>
  z.object({ data, slots: z.record(z.string(), SlotSchema), sources: z.array(SourceSchema) });

export const OUTPUT_SCHEMAS = {
  market_state: envelope(
    z.looseObject({
      symbol: z.string(),
      now: z.number(),
      session: z.looseObject({ session: z.string() }),
      venues: z.looseObject({}),
      events: z.array(z.unknown()),
    }),
  ),
  research: envelope(
    z.looseObject({ symbol: z.string(), unavailable: z.array(z.string()), flags: z.array(z.unknown()) }),
  ),
  liquidity_tide: envelope(
    z.looseObject({ symbol: z.string(), timeline: z.array(z.unknown()), live: z.looseObject({}) }),
  ),
  price_options: envelope(
    z.looseObject({
      best: QuoteSchema.nullable(),
      baseline: QuoteSchema.nullable(),
      families: z.record(z.string(), QuoteSchema),
      gate: z
        .looseObject({ verdict: z.enum(["allow", "hold", "refuse"]), checks: z.array(CheckSchema) })
        .nullable(),
      frontier: z.array(z.unknown()),
    }),
  ),
  build_plan: envelope(
    z.looseObject({
      planId: z.string(),
      verdict: z.enum(["allow", "hold", "refuse"]),
      checks: z.array(CheckSchema),
      strategy: QuoteSchema,
      alternatives: z.array(QuoteSchema),
      slices: z.array(z.unknown()),
      expiresAt: z.number(),
      publicKey: z.string(),
      signedPlan: z.looseObject({ hash: z.string(), sig: z.string(), issuedAt: z.number() }),
    }),
  ),
  issue_tickets: envelope(z.looseObject({ ok: z.boolean(), planId: z.string() })),
  explain: envelope(z.looseObject({ topic: z.string(), found: z.boolean() })),
  track_record: envelope(z.looseObject({ status: z.string() })),
} as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const ProfileArg = ProfileSchema.optional().describe(
  "Trader profile; defaults to a normal-urgency profile with a cost cap",
);
const oneSize = (i: { notionalUsd?: number | undefined; qty?: number | undefined }) =>
  (i.notionalUsd === undefined) !== (i.qty === undefined);
const OptionsArgs = z
  .object({ ...IntentFields, profile: ProfileArg })
  .refine(oneSize, { message: "give exactly one of notionalUsd or qty" });
const PlanArgs = z
  .object({ ...IntentFields, strategyId: StrategyIdSchema, profile: ProfileArg })
  .refine(oneSize, { message: "give exactly one of notionalUsd or qty" });

const fmt = (x: number, dp = 1) => (Number.isFinite(x) ? x.toFixed(dp) : "n/a");

const unavailable = (r: DeskResult<unknown>): string => {
  const down = [...new Set(r.sources.filter((s) => s.status === "unavailable").map((s) => s.id))];
  return down.length ? `\nUnavailable sources: ${down.join(", ")}.` : "";
};
const failing = (checks: CheckView[]) =>
  checks
    .filter((c) => c.status !== "pass")
    .map((c) => `${c.code} ${c.status}: ${c.detail}${c.fix ? ` — fix: ${c.fix}` : ""}`);
const band = (q: QuoteView) => `${fmt(q.expectedBps)} bps (p10 ${fmt(q.p10Bps)}, p90 ${fmt(q.p90Bps)})`;

const SUMMARIES: Record<string, (r: DeskResult<never>) => string> = {
  price_options: (r: DeskResult<OptionsData>) => {
    const d = r.data;
    return [
      d.best
        ? `Best: ${d.best.label} [${d.best.id}] — expected ${band(d.best)}, ≈ $${fmt(d.best.expectedCostUsd, 0)} on $${fmt(d.notionalUsd, 0)}.`
        : "No feasible strategy on current data.",
      d.baseline ? `TWAP baseline: ${d.baseline.label} — expected ${band(d.baseline)}.` : "",
      ...Object.entries(d.families).map(([k, q]) => (q ? `- ${k}: ${q.label} [${q.id}] ${band(q)}` : "")),
      d.gate ? `Gate preview for best: ${d.gate.verdict.toUpperCase()}` : "",
      ...(d.gate ? failing(d.gate.checks) : []),
      `Atlas: ${d.atlas.status}. ${d.candidates} strategies priced, ${d.skipped.count} skipped.`,
    ]
      .filter(Boolean)
      .join("\n")
      .concat(unavailable(r));
  },
  build_plan: (r: DeskResult<PlanData>) => {
    const d = r.data;
    return [
      `Plan ${d.planId}: ${d.strategy.label} — verdict ${d.verdict.toUpperCase()}. Expected ${band(d.strategy)}; ${d.slices.length} slice(s).`,
      ...failing(d.checks),
      d.verdict === "allow"
        ? `Tickets: call issue_tickets with this signedPlan before ${new Date(d.expiresAt).toISOString()}, after the trader confirms.`
        : "Not ticketable: apply a fix and re-plan.",
    ]
      .join("\n")
      .concat(unavailable(r));
  },
  issue_tickets: (r: DeskResult<TicketsData>) => {
    const d = r.data;
    return d.ok
      ? `${d.tickets.length} dry-run ticket(s) for plan ${d.planId} (nothing sent):\n${d.tickets.map((t) => `#${t.index} ${t.bgc}`).join("\n")}`
      : [`Refused for plan ${d.planId}: ${d.reason}`, ...failing(d.fixes)].join("\n");
  },
  explain: (r: DeskResult<ExplainData>) =>
    r.data.found ? `${r.data.title}: ${r.data.text}` : `Unknown topic. Topics: ${r.data.topics.join(", ")}`,
};

const summary = (tool: string, r: DeskResult<unknown>): string =>
  SUMMARIES[tool]?.(r as DeskResult<never>) ?? JSON.stringify(r.data).slice(0, 4000) + unavailable(r);

async function call(
  tool: string,
  f: () => Promise<DeskResult<unknown>> | DeskResult<unknown>,
): Promise<CallToolResult> {
  try {
    const r = await f();
    return {
      content: [{ type: "text", text: summary(tool, r) }],
      structuredContent: r as unknown as Record<string, unknown>,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof DeskError ? e.code : "ERROR";
    return { content: [{ type: "text", text: `${code}: ${msg}` }], isError: true };
  }
}

export function createSlipwayMcpServer(desk: Desk = new Desk()): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const Sym = z.object({ symbol: SymbolSchema });

  server.registerTool(
    "market_state",
    {
      title: "Market state",
      description: TOOL_DESCRIPTIONS.market_state,
      inputSchema: Sym,
      outputSchema: OUTPUT_SCHEMAS.market_state,
      annotations: READ_ONLY,
    },
    ({ symbol }) => call("market_state", () => desk.marketState(symbol)),
  );
  server.registerTool(
    "research",
    {
      title: "Research",
      description: TOOL_DESCRIPTIONS.research,
      inputSchema: Sym,
      outputSchema: OUTPUT_SCHEMAS.research,
      annotations: READ_ONLY,
    },
    ({ symbol }) => call("research", () => desk.research(symbol)),
  );
  server.registerTool(
    "liquidity_tide",
    {
      title: "Liquidity tide",
      description: TOOL_DESCRIPTIONS.liquidity_tide,
      inputSchema: Sym,
      outputSchema: OUTPUT_SCHEMAS.liquidity_tide,
      annotations: READ_ONLY,
    },
    ({ symbol }) => call("liquidity_tide", () => desk.liquidityTide(symbol)),
  );
  server.registerTool(
    "price_options",
    {
      title: "Price execution options",
      description: TOOL_DESCRIPTIONS.price_options,
      inputSchema: OptionsArgs,
      outputSchema: OUTPUT_SCHEMAS.price_options,
      annotations: READ_ONLY,
    },
    ({ profile, ...intent }) =>
      call("price_options", () => desk.priceOptions(intent, profile ?? DEFAULT_PROFILE)),
  );
  registerAppTool(
    server,
    "build_plan",
    {
      title: "Build signed plan",
      description: `${TOOL_DESCRIPTIONS.build_plan} The result carries signedPlan: pass it unchanged to issue_tickets.`,
      inputSchema: PlanArgs,
      outputSchema: OUTPUT_SCHEMAS.build_plan,
      annotations: READ_ONLY,
      _meta: { ui: { resourceUri: PLAN_CARD_URI } },
    },
    ({ profile, strategyId, ...intent }) =>
      call("build_plan", () => desk.buildPlan(intent, profile ?? DEFAULT_PROFILE, strategyId)),
  );
  registerAppTool(
    server,
    "issue_tickets",
    {
      title: "Issue dry-run tickets",
      description:
        "Dry-run order tickets (Bitget agent SDK requests + bgc commands) for a signedPlan from build_plan. Refused unless the signature verifies with this desk's key, the verdict is ALLOW and the plan was signed within the validity window. Only after the trader confirms. Nothing is sent.",
      inputSchema: z.object({
        signedPlan: z
          .looseObject({ hash: z.string(), sig: z.string(), issuedAt: z.number() })
          .describe("signedPlan from build_plan, unchanged"),
      }),
      outputSchema: OUTPUT_SCHEMAS.issue_tickets,
      annotations: { ...READ_ONLY, idempotentHint: true },
      _meta: { ui: { resourceUri: PLAN_CARD_URI } },
    },
    ({ signedPlan }) => call("issue_tickets", () => desk.issueTickets(signedPlan as never)),
  );
  server.registerTool(
    "explain",
    {
      title: "Explain",
      description: TOOL_DESCRIPTIONS.explain,
      inputSchema: z.object({
        topic: z
          .string()
          .min(1)
          .max(60)
          .describe(`One of: ${TOPICS.join(", ")}`),
      }),
      outputSchema: OUTPUT_SCHEMAS.explain,
      annotations: { ...READ_ONLY, openWorldHint: false, idempotentHint: true },
    },
    ({ topic }) => call("explain", () => desk.explain(topic)),
  );
  server.registerTool(
    "track_record",
    {
      title: "Track record",
      description: TOOL_DESCRIPTIONS.track_record,
      inputSchema: z.object({ symbol: SymbolSchema.optional() }),
      outputSchema: OUTPUT_SCHEMAS.track_record,
      annotations: READ_ONLY,
    },
    ({ symbol }) => call("track_record", () => desk.trackRecord(symbol)),
  );
  registerAppResource(
    server,
    "Slipway plan card",
    PLAN_CARD_URI,
    {
      description:
        "Plan card: venue options with cost bands, gate verdict and fixes, slices and dry-run tickets.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({ contents: [{ uri: PLAN_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: PLAN_CARD_HTML }] }),
  );
  return server;
}
