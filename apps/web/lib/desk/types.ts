// Client-side shapes for the desk. API payloads come from @slipway/sdk (types only); the tool envelope and the
// rendered-text parts mirror @slipway/agent so the browser bundle never pulls in server code.
import type {
  IntentRequest,
  MarketData,
  OptionsData,
  PlanData,
  Profile,
  ResearchData,
  Slot,
  SourceRef,
  TicketsData,
  TideData,
} from "@slipway/sdk";

export type {
  CheckView,
  IntentRequest,
  MarketData,
  OptionsData,
  OrderTicket,
  PlanData,
  Profile,
  QuoteView,
  ResearchData,
  Session,
  SessionStats,
  SliceView,
  Slot,
  SourceRef,
  StrategyKind,
  TicketsData,
  TideData,
  Venue,
} from "@slipway/sdk";

export type ToolName =
  | "market_state"
  | "research"
  | "liquidity_tide"
  | "price_options"
  | "build_plan"
  | "issue_tickets"
  | "explain"
  | "track_record"
  | "get_profile"
  | "propose_profile_update";

export interface ToolEnvelope<T = unknown> {
  tag: string;
  tool: ToolName;
  ok: boolean;
  data?: T;
  slots: Record<string, Slot>;
  sources: SourceRef[];
  error?: { code: string; message: string };
  callId?: string;
}

export type RenderPart =
  | { kind: "text"; text: string }
  | { kind: "slot"; name: string; text: string; source: string }
  | { kind: "flag"; raw: string; text: string };

export interface Rendered {
  ok: boolean;
  text: string;
  parts: RenderPart[];
  flags: { raw: string; reason: string }[];
}

export interface ProfileProposal {
  proposal: {
    patch: Partial<Profile>;
    reason: string;
    before: Profile;
    after: Profile;
    changed: string[];
  };
  requiresConfirmation: true;
}

export type Origin = "chat" | "form";

/** One API result held by the canvas, with where it came from and when it arrived (client clock). */
export interface Held<T> {
  data: T;
  sources: SourceRef[];
  origin: Origin;
  at: number;
  callId?: string;
  /** The order exactly as sent (needed to re-price or re-sign the same order). */
  intent?: IntentRequest;
}

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  sources: SourceRef[];
}

export type Loadable = "market" | "tide" | "research" | "options" | "plan" | "tickets";

export interface DeskState {
  symbol: string;
  market: Held<MarketData> | null;
  tide: Held<TideData> | null;
  research: Held<ResearchData> | null;
  options: Held<OptionsData> | null;
  plan: Held<PlanData> | null;
  tickets: Held<TicketsData> | null;
  busy: Partial<Record<Loadable, string>>;
  errors: Partial<Record<Loadable, ApiFailure>>;
  /** Evidence ledger: the latest observation of every source seen this session. */
  sources: Record<string, { ref: SourceRef; seenAt: number; via: string }>;
  /** Tool calls already copied onto the canvas (by toolCallId). */
  seen: Record<string, true>;
}
