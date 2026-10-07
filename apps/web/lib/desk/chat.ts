// Reading AI SDK UI messages: tool parts (with their Slipway envelopes), the authoritative data-render part, and
// one-line summaries for the conversation's tool timeline.
import type { UIMessage } from "ai";
import { isEnvelope } from "./compact";
import { bps, pluralize, sessionLabel } from "./format";
import type {
  IntentRequest,
  MarketData,
  OptionsData,
  PlanData,
  Rendered,
  ResearchData,
  SourceRef,
  TicketsData,
  TideData,
  ToolEnvelope,
  ToolName,
} from "./types";

export type AnyPart = UIMessage["parts"][number];

export interface ToolPartView {
  toolCallId: string;
  tool: ToolName;
  state: string;
  input: Record<string, unknown> | undefined;
  envelope: ToolEnvelope | null;
  errorText: string | null;
}

export function toolPart(p: AnyPart): ToolPartView | null {
  if (typeof p.type !== "string" || !p.type.startsWith("tool-")) return null;
  const q = p as unknown as {
    toolCallId: string;
    state: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  return {
    toolCallId: q.toolCallId,
    tool: p.type.slice(5) as ToolName,
    state: q.state,
    input: (q.input && typeof q.input === "object" ? q.input : undefined) as
      | Record<string, unknown>
      | undefined,
    envelope: isEnvelope(q.output) ? q.output : null,
    errorText: q.errorText ?? null,
  };
}

export function renderedOf(m: UIMessage): Rendered | null {
  for (let i = m.parts.length - 1; i >= 0; i--) {
    const p = m.parts[i] as { type?: string; data?: unknown };
    if (p.type === "data-render" && p.data && typeof p.data === "object") return p.data as Rendered;
  }
  return null;
}

export function repairOf(m: UIMessage): { flags: { raw: string; reason: string }[] } | null {
  for (const p of m.parts as { type?: string; data?: unknown }[])
    if (p.type === "data-repair" && p.data && typeof p.data === "object")
      return p.data as { flags: { raw: string; reason: string }[] };
  return null;
}

export function textOf(m: UIMessage): string {
  return m.parts
    .map((p) => (p.type === "text" ? (p as { text: string }).text : ""))
    .join("")
    .trim();
}

/** The order a price_options / build_plan call was made with (strategyId stripped). */
export function intentOfInput(input: Record<string, unknown> | undefined): IntentRequest | undefined {
  if (!input || typeof input.symbol !== "string" || (input.side !== "buy" && input.side !== "sell"))
    return undefined;
  const { strategyId: _drop, ...rest } = input as Record<string, unknown> & { strategyId?: unknown };
  return rest as unknown as IntentRequest;
}

export function sourceCounts(sources: SourceRef[]): { live: number; cached: number; unavailable: number } {
  const seen = new Map<string, SourceRef>();
  for (const s of sources) seen.set(s.id, s);
  const out = { live: 0, cached: 0, unavailable: 0 };
  for (const s of seen.values()) out[s.status]++;
  return out;
}

export type Focus = "tide" | "options" | "gate" | "tickets" | "ledger" | "profile" | null;

export interface ToolSummary {
  running: string;
  done: string;
  focus: Focus;
}

/** "priced 53 strategies", "signed plan 9d48f3f3 · ALLOW", … — from the envelope's data, never from model text. */
export function summarize(t: ToolPartView): ToolSummary {
  const sym = typeof t.input?.symbol === "string" ? t.input.symbol.toUpperCase() : "";
  const e = t.envelope;
  const failed = e && !e.ok && e.error ? `${e.error.message}` : null;
  switch (t.tool) {
    case "price_options": {
      const d = e?.data as OptionsData | undefined;
      return {
        running: `pricing every venue, session and slicing for ${sym || "the order"}`,
        done: failed
          ? `could not price: ${failed}`
          : d
            ? `priced ${pluralize(d.candidates, "strategy", "strategies")}${d.best ? `, best ${bps(d.best.expectedBps)}` : ", none feasible"}`
            : "priced the order",
        focus: "options",
      };
    }
    case "build_plan": {
      const d = e?.data as PlanData | undefined;
      const sid = typeof t.input?.strategyId === "string" ? t.input.strategyId : "the strategy";
      return {
        running: `gating and signing ${sid}`,
        done: failed
          ? `could not build the plan: ${failed}`
          : d
            ? `signed plan ${d.planId}, gate ${d.verdict.toUpperCase()}`
            : "built a plan",
        focus: "gate",
      };
    }
    case "issue_tickets": {
      const d = e?.data as TicketsData | undefined;
      return {
        running: "issuing dry-run tickets",
        done: failed
          ? `tickets failed: ${failed}`
          : d?.ok
            ? `issued ${pluralize(d.tickets.length, "dry-run ticket")}`
            : d
              ? `tickets refused: ${d.reason}`
              : "tickets",
        focus: "tickets",
      };
    }
    case "liquidity_tide": {
      const d = e?.data as TideData | undefined;
      return {
        running: `reading the ${sym} liquidity tide`,
        done: failed
          ? `tide unavailable: ${failed}`
          : d
            ? `read the ${d.symbol} tide over ${pluralize(d.timeline.length, "session span")}`
            : "read the tide",
        focus: "tide",
      };
    }
    case "market_state": {
      const d = e?.data as MarketData | undefined;
      const lv = d?.venues.rtoken?.book?.levels;
      return {
        running: `reading the live ${sym} books`,
        done: failed
          ? `market unavailable: ${failed}`
          : d
            ? `read the live ${d.symbol} books${lv ? `, ${lv.bids + lv.asks} rToken levels` : ""}, ${sessionLabel(d.session.session)}`
            : "read the market",
        focus: "tide",
      };
    }
    case "research": {
      const d = e?.data as ResearchData | undefined;
      return {
        running: `researching ${sym} across Bitget skills`,
        done: failed
          ? `research failed: ${failed}`
          : d
            ? `researched ${d.symbol}${d.flags.length ? `, ${pluralize(d.flags.length, "cross-check flag")}` : ""}`
            : "researched",
        focus: "ledger",
      };
    }
    case "explain":
      return { running: "looking it up", done: `looked up "${String(t.input?.topic ?? "")}"`, focus: null };
    case "track_record":
      return { running: "reading the track record", done: "read the graded track record", focus: null };
    case "get_profile":
      return { running: "reading your profile", done: "read your profile", focus: "profile" };
    case "propose_profile_update":
      return { running: "drafting a profile change", done: "proposed a profile change", focus: "profile" };
    default:
      return { running: String(t.tool), done: String(t.tool), focus: null };
  }
}
