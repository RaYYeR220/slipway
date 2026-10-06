// The Slipway HTTP API contract. The server (@slipway/agent) is type-checked against these shapes.
import type {
  FundingInfo,
  GateResult,
  Profile,
  Session,
  SessionInfo,
  SignedPlan,
  SourceRef,
  StrategyKind,
  StrategyQuote,
  Venue,
} from "@slipway/core";

export type {
  Book,
  CostComponents,
  GateCheck,
  GateCode,
  GateResult,
  OrderIntent,
  Plan,
  Profile,
  Session,
  SignedPlan,
  Slice,
  SourceRef,
  StrategyKind,
  StrategyQuote,
  Urgency,
  Venue,
  Verdict,
} from "@slipway/core";

export type SlotUnit = "bps" | "usd" | "pct" | "count" | "qty" | "price" | "seconds" | "text";

/** A code-filled figure the model may cite as {{name}}; `source` is a SourceRef id or a desk component. */
export interface Slot {
  value: number | string;
  unit: SlotUnit;
  dp?: number;
  signed?: boolean;
  source: string;
}

export type Slots = Record<string, Slot>;

/** Every successful response: data for code/UI, slots for the renderer, and the sources behind them. */
export interface DeskResult<T> {
  data: T;
  slots: Slots;
  sources: SourceRef[];
}

export interface ApiError {
  error: { code: "BAD_INPUT" | "NO_MARKET" | "NOT_FOUND" | "UNAVAILABLE" | "ERROR"; message: string };
  sources: SourceRef[];
}

/** The order as the trader states it; `deadline` is free text resolved by the server ("before thursday"). */
export interface IntentRequest {
  symbol: string;
  side: "buy" | "sell";
  notionalUsd?: number;
  qty?: number;
  deadline?: string;
  holdHorizonHours?: number;
  venues?: Venue[];
  urgency?: Profile["urgency"];
}

export interface OptionsRequest {
  intent: IntentRequest;
  profile?: Profile;
}

export interface PlanRequest {
  intent: IntentRequest;
  profile?: Profile;
  /** A strategy id from options, or "best", "baseline", "best:<family>". */
  strategyId: string;
}

export interface TicketsRequest {
  signedPlan: SignedPlan;
}

export interface ResolvedIntent {
  symbol: string;
  side: "buy" | "sell";
  notionalUsd?: number;
  qty?: number;
  deadline?: number;
  deadlineNy?: string;
  deadlineReading?: string;
  holdHorizonHours?: number;
  venues?: Venue[];
  urgency: Profile["urgency"];
}

export interface QuoteView {
  id: string;
  kind: StrategyKind;
  label: string;
  feasible: boolean;
  violations: string[];
  expectedBps: number;
  sdBps: number;
  p10Bps: number;
  p90Bps: number;
  score: number;
  qty: number;
  notionalUsd: number;
  expectedCostUsd: number;
  components: StrategyQuote["components"];
  startsAt: number;
  endsAt: number;
  startsNy: string;
  endsNy: string;
  venues: Venue[];
  sessions: string[];
  sliceCount: number;
  assumptions: string[];
}

export interface CheckView {
  code: string;
  status: string;
  detail: string;
  fix?: string;
}

export interface GatePreview {
  strategyId: string;
  verdict: GateResult["verdict"];
  checks: CheckView[];
}

export interface AtlasStatus {
  status: SourceRef["status"];
  asOf: number | null;
  keys: number;
  detail?: string;
}

export interface OptionsData {
  intent: ResolvedIntent;
  profile: Profile;
  now: number;
  nowNy: string;
  qty: number;
  notionalUsd: number;
  arrivalMids: Partial<Record<Venue, number>>;
  basisBps: number | null;
  lambda: number;
  best: QuoteView | null;
  baseline: QuoteView | null;
  families: Partial<Record<StrategyKind, QuoteView>>;
  savingVsBaseline: { bps: number; usd: number } | null;
  /** Every priced candidate, for the cost/risk frontier chart. */
  frontier: {
    id: string;
    kind: StrategyKind;
    expectedBps: number;
    sdBps: number;
    score: number;
    feasible: boolean;
  }[];
  candidates: number;
  skipped: { count: number; reasons: { reason: string; count: number }[] };
  assumptions: string[];
  gate: GatePreview | null;
  atlas: AtlasStatus;
}

export interface SliceView {
  index: number;
  t: number;
  ny: string;
  venue: Venue;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  limitPx: number | null;
  session: string;
  expectedBps: number;
  leg: "entry" | "rotate_out" | "rotate_in";
  conditional: boolean;
}

export interface PlanData {
  planId: string;
  signedPlan: SignedPlan;
  verdict: GateResult["verdict"];
  checks: CheckView[];
  strategy: QuoteView;
  /** Best plan per family and the TWAP baseline from the same pricing run, for comparison. */
  alternatives: QuoteView[];
  slices: SliceView[];
  /** Tickets are refused after this instant (signature age limit). */
  expiresAt: number;
  publicKey: string;
  keyOrigin: "env" | "ephemeral";
  intent: ResolvedIntent;
}

export interface TicketRequestBody {
  operationId: string;
  method: string;
  path: string;
  body: Record<string, string>;
}

export interface OrderTicket {
  index: number;
  clientOid: string;
  venue: Venue;
  symbol: string;
  side: "buy" | "sell";
  t: number;
  session: Session;
  kind: "ioc_limit" | "post_only" | "gtc_limit" | "market" | "cancel_remaining_then_market";
  conditional: boolean;
  qty: number;
  limitPx: number | null;
  request: TicketRequestBody;
  bgc: string;
  cancel?: TicketRequestBody & { targetIndex: number; targetClientOid: string; bgc: string };
  notes: string[];
  violations: string[];
  sdkVersion: string;
}

export type TicketsData =
  | {
      ok: true;
      planId: string;
      dryRun: true;
      tickets: OrderTicket[];
      maxSlippageBps: number;
      notes: string[];
    }
  | {
      ok: false;
      planId: string;
      reason: string;
      verdict: GateResult["verdict"] | null;
      fixes: CheckView[];
      tickets?: OrderTicket[];
    };

export interface BookView {
  mid: number;
  bid: number;
  ask: number;
  spreadBps: number;
  /** USD reachable within ±10/25/50 bps of mid, per side. */
  depthUsd: Record<"b10" | "b25" | "b50", { bid: number; ask: number }>;
  ageMs: number;
  levels: { bids: number; asks: number };
}

export interface IntegrityFlag {
  code: string;
  source: string;
  severity: "info" | "warn";
  detail: string;
}

export interface MarketData {
  symbol: string;
  now: number;
  nowNy: string;
  session: SessionInfo;
  venues: Record<
    Venue,
    { tradableNow: boolean; book: BookView | null; fees: { maker: number; taker: number } } | null
  >;
  basisBps: number | null;
  funding: FundingInfo | null;
  nextSessions: { session: Session; start: number; end: number; startNy: string; endNy: string }[];
  events: { kind: string; label: string; ts: number; ny: string; windowSec: number; source: string }[];
  integrity: IntegrityFlag[];
  indexComponents: { source: string; price: number; weight: number }[] | null;
  atlas: AtlasStatus;
}

export type SessionStats = {
  n: number;
  spreadBpsP50: number;
  depth10UsdP50: number;
  depth25UsdP50: number;
  depth25UsdP10: number;
  depth50UsdP50: number;
  flowUsdPerMinP50: number;
  sigmaBpsPerSqrtSec: number;
  halfLifeSec: number | null;
} | null;

export interface TideData {
  symbol: string;
  now: number;
  nowNy: string;
  live: {
    session: Session;
    venues: Partial<
      Record<Venue, { spreadBps: number; depth10Usd: number; depth25Usd: number; depth50Usd: number }>
    >;
  };
  /** Upcoming session spans with the atlas statistics of each venue (null when the atlas has no such key). */
  timeline: {
    session: Session;
    start: number;
    end: number;
    startNy: string;
    venues: Record<Venue, { tradable: boolean; stats: SessionStats }>;
  }[];
  bySession: { session: Session; rtoken: SessionStats; perp: SessionStats }[];
  atlas: AtlasStatus;
  units: { depth: string; spread: string };
}

export interface TrackData {
  status: SourceRef["status"];
  since: number | null;
  detail: string | null;
  record: Record<string, unknown> | null;
}

export interface ExplainData {
  topic: string;
  found: boolean;
  title: string | null;
  text: string | null;
  topics: string[];
}

export interface ResearchData {
  symbol: string;
  quote: {
    symbol: string;
    last: number | null;
    changePct: number | null;
    lastTradeTs: number | null;
    sipTs: number | null;
    cashStalenessSec: number | null;
  } | null;
  fearGreed: { score: number; rating: string | null; ts: number | null } | null;
  perp24h: {
    last: number;
    high: number;
    low: number;
    volume: number;
    quoteVolume: number;
    changePct: number;
    ts: number;
  } | null;
  technicals: {
    source: string;
    bars: number;
    rsi14: number;
    atr14: number;
    hourlyVolBps: number;
    rangeHigh: number;
    rangeLow: number;
  } | null;
  bollinger: {
    recomputed: { middle: number; upper: number; lower: number; bandwidth: number; pctB: number };
    reported: { upper: number; middle: number; lower: number };
  } | null;
  headlines: { title: string; at: number | null; source: string }[];
  flags: { code: string; source: string; severity: string; detail: string }[];
  unavailable: string[];
}

export interface KeysData {
  publicKey: string;
  alg: "Ed25519";
  origin: "env" | "ephemeral";
  /** Signed message: utf8 `${domain}:${hash}:${issuedAt}`. */
  domain: "slipway-plan-v1";
}

export type OptionsResponse = DeskResult<OptionsData>;
export type PlanResponse = DeskResult<PlanData>;
export type TicketsResponse = DeskResult<TicketsData>;
export type MarketResponse = DeskResult<MarketData>;
export type TideResponse = DeskResult<TideData>;
export type TrackRecordResponse = DeskResult<TrackData>;
export type ResearchResponse = DeskResult<ResearchData>;
export type ExplainResponse = DeskResult<ExplainData>;
