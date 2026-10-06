// LLM tools over the desk. Each returns a ToolEnvelope (full data for the UI); the model sees only modelView().
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { TOPICS } from "../desk/explain.js";
import {
  type IntentInput,
  IntentSchema,
  PlanInputSchema,
  ProfilePatchSchema,
  SymbolSchema,
} from "../desk/schemas.js";
import { DeskError } from "../desk/service.js";
import { type DeskResult, SlotBag } from "../desk/slots.js";
import { type DeskSession, modelView, type ToolEnvelope, type ToolName } from "./session.js";

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  market_state:
    "Live Bitget state for one stock: rToken and perp books (mid, spread, depth), fees, funding, basis, current and next New York sessions, scheduled events, data-integrity flags. Read-only.",
  research:
    "Evidence around the stock from Bitget's skills: cash-market quote (bitget-mcp), perp 24h stats and technicals recomputed from Bitget's own bars (RSI, ATR, Bollinger audit of the signal MCP), headlines, fear & greed. Lists sources that were unavailable. Read-only.",
  liquidity_tide:
    "How deep and tight each venue is in each session over the coming days (from the recorded atlas) versus the live book now. Read-only.",
  price_options:
    "Price every execution strategy (venue x session x slicing) for an order against the live book: the best plan, the best per family, the Bitget-app TWAP baseline and a gate preview. Call this first for any order. Read-only.",
  build_plan:
    'Build, gate and sign one strategy for the order (use an id from price_options ids, or "best"). Returns the verdict (ALLOW / HOLD / REFUSE) with each check and its fix, and a planId. Read-only.',
  issue_tickets:
    "Dry-run order tickets (Bitget agent SDK requests + bgc commands) for a signed plan with an ALLOW verdict, issued within its validity window. Only after the trader confirms. Nothing is sent to the exchange.",
  explain: `Plain-language explanation of a cost component, strategy family, gate check or concept. Topics: ${TOPICS.join(", ")}.`,
  track_record:
    "The desk's graded forecast track record (forecast vs realized cost on the recorded tape), if published.",
  get_profile:
    "The trader's current profile: urgency, cost cap, participation cap, perps allowed, avoided sessions.",
  propose_profile_update:
    "Propose a lasting change to the trader's profile. It only takes effect after the trader confirms it in the UI.",
};

const errorEnvelope = (tag: string, toolName: ToolName, e: unknown): ToolEnvelope => {
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof DeskError ? e.code : "ERROR";
  const bag = new SlotBag({}, `${tag}.`);
  bag.text("error", message, "slipway.desk");
  return {
    tag,
    tool: toolName,
    ok: false,
    slots: bag.slots,
    sources: e instanceof DeskError ? e.sources : [],
    error: { code, message },
  };
};

function wrap<T>(tag: string, toolName: ToolName, r: DeskResult<T>, ok = true): ToolEnvelope<T> {
  const slots: ToolEnvelope["slots"] = {};
  for (const [k, v] of Object.entries(r.slots)) slots[`${tag}.${k}`] = v;
  const down = [...new Set(r.sources.filter((x) => x.status === "unavailable").map((x) => x.id))];
  slots[`${tag}.unavailable`] ??= {
    value: down.length ? down.join(", ") : "none",
    unit: "text",
    source: "slipway.desk",
  };
  return { tag, tool: toolName, ok, data: r.data, slots, sources: r.sources };
}

async function run<T>(
  s: DeskSession,
  toolName: ToolName,
  callId: string,
  f: () => Promise<DeskResult<T>> | DeskResult<T>,
  ok?: (d: T) => boolean,
): Promise<ToolEnvelope> {
  const tag = s.nextTag(toolName);
  let env: ToolEnvelope;
  try {
    const r = await f();
    env = wrap(tag, toolName, r, ok ? ok(r.data) : true);
  } catch (e) {
    env = errorEnvelope(tag, toolName, e);
  }
  env.callId = callId;
  s.record(env);
  return env;
}

const toModelOutput = ({ output }: { output: ToolEnvelope }) => ({
  type: "json" as const,
  value: modelView(output) as never,
});

const SymbolInput = z.object({ symbol: SymbolSchema });

export function deskTools(s: DeskSession): ToolSet {
  const d = s.desk;
  return {
    market_state: tool({
      description: TOOL_DESCRIPTIONS.market_state,
      inputSchema: SymbolInput,
      execute: ({ symbol }, o) => run(s, "market_state", o.toolCallId, () => d.marketState(symbol)),
      toModelOutput,
    }),
    research: tool({
      description: TOOL_DESCRIPTIONS.research,
      inputSchema: SymbolInput,
      execute: ({ symbol }, o) => run(s, "research", o.toolCallId, () => d.research(symbol)),
      toModelOutput,
    }),
    liquidity_tide: tool({
      description: TOOL_DESCRIPTIONS.liquidity_tide,
      inputSchema: SymbolInput,
      execute: ({ symbol }, o) => run(s, "liquidity_tide", o.toolCallId, () => d.liquidityTide(symbol)),
      toModelOutput,
    }),
    price_options: tool({
      description: TOOL_DESCRIPTIONS.price_options,
      inputSchema: IntentSchema,
      execute: (intent, o) =>
        run(s, "price_options", o.toolCallId, () => d.priceOptions(intent as IntentInput, s.profile)),
      toModelOutput,
    }),
    build_plan: tool({
      description: TOOL_DESCRIPTIONS.build_plan,
      inputSchema: PlanInputSchema,
      execute: ({ strategyId, ...intent }, o) =>
        run(s, "build_plan", o.toolCallId, () => d.buildPlan(intent as IntentInput, s.profile, strategyId)),
      toModelOutput,
    }),
    issue_tickets: tool({
      description: TOOL_DESCRIPTIONS.issue_tickets,
      inputSchema: z.object({ planId: z.string().min(6).max(64).describe("planId returned by build_plan") }),
      execute: ({ planId }, o) =>
        run(
          s,
          "issue_tickets",
          o.toolCallId,
          () => {
            const signed = s.plans.get(planId.trim());
            if (!signed)
              throw new DeskError(
                `no signed plan ${planId} in this conversation; call build_plan first`,
                "NOT_FOUND",
              );
            return d.issueTickets(signed);
          },
          (r) => (r as { ok: boolean }).ok,
        ),
      toModelOutput,
    }),
    explain: tool({
      description: TOOL_DESCRIPTIONS.explain,
      inputSchema: z.object({ topic: z.string().min(1).max(60) }),
      execute: ({ topic }, o) => run(s, "explain", o.toolCallId, () => d.explain(topic)),
      toModelOutput,
    }),
    track_record: tool({
      description: TOOL_DESCRIPTIONS.track_record,
      inputSchema: z.object({ symbol: SymbolSchema.optional() }),
      execute: ({ symbol }, o) => run(s, "track_record", o.toolCallId, () => d.trackRecord(symbol)),
      toModelOutput,
    }),
    get_profile: tool({
      description: TOOL_DESCRIPTIONS.get_profile,
      inputSchema: z.object({}),
      execute: (_i, o) => run(s, "get_profile", o.toolCallId, () => profileResult(s)),
      toModelOutput,
    }),
    propose_profile_update: tool({
      description: TOOL_DESCRIPTIONS.propose_profile_update,
      inputSchema: z.object({
        patch: ProfilePatchSchema.describe("Only the fields to change"),
        reason: z.string().max(200).describe("The trader's words that motivate the change"),
      }),
      execute: ({ patch, reason }, o) =>
        run(s, "propose_profile_update", o.toolCallId, () => proposalResult(s, patch, reason)),
      toModelOutput,
    }),
  };
}

const USER = "user.profile";

function profileSlots(bag: SlotBag, p: DeskSession["profile"]): void {
  bag
    .text("name", p.name, USER)
    .text("urgency", p.urgency, USER)
    .bps("costCap", p.costCapBps, USER)
    .pct("maxParticipation", p.maxParticipation, USER, 1)
    .text("perps", p.allowPerp ? "allowed" : "not allowed", USER)
    .put("maxLeverage", p.maxLeverage, "price", USER, { dp: 1 })
    .text("avoidSessions", p.avoidSessions.length ? p.avoidSessions.join(", ") : "none", USER)
    .text("avoidEvents", p.avoidEvents ? "yes" : "no", USER);
}

function profileResult(s: DeskSession): DeskResult<{ profile: DeskSession["profile"] }> {
  const bag = new SlotBag();
  profileSlots(bag.scope("profile"), s.profile);
  return { data: { profile: s.profile }, slots: bag.slots, sources: [] };
}

function proposalResult(s: DeskSession, patch: z.infer<typeof ProfilePatchSchema>, reason: string) {
  const before = s.profile;
  const after = { ...before, ...patch };
  const changed = Object.keys(patch).filter(
    (k) => JSON.stringify((before as never)[k]) !== JSON.stringify((after as never)[k]),
  );
  const bag = new SlotBag();
  profileSlots(bag.scope("before"), before);
  profileSlots(bag.scope("after"), after);
  bag
    .text("changed", changed.length ? changed.join(", ") : "nothing", USER)
    .text("status", "awaiting confirmation in the UI", USER);
  return {
    data: { proposal: { patch, reason, before, after, changed }, requiresConfirmation: true as const },
    slots: bag.slots,
    sources: [],
  };
}
