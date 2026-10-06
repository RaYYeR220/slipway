// Shared domain types. Units: prices in USDT, quantities in base units (shares),
// costs in basis points of the arrival mid (positive = cost to the trader), time in ms since epoch (UTC).

export type Venue = "rtoken" | "perp";
export type Side = "buy" | "sell";

export type Session = "pre_market" | "regular" | "after_hours" | "overnight" | "weekend" | "closed";

export interface Level {
  px: number;
  sz: number;
}

export interface Book {
  venue: Venue;
  symbol: string; // underlying ticker, e.g. "NVDA"
  ts: number; // exchange timestamp of the snapshot
  bids: Level[]; // best first (descending price)
  asks: Level[]; // best first (ascending price)
}

export interface Fees {
  maker: number; // fraction, e.g. 0.0002 (may be negative for rebates)
  taker: number;
}

export interface FundingInfo {
  rate: number; // per interval, fraction (long pays when positive)
  intervalHours: number;
  nextFundingTime: number;
}

export interface SymbolSessions {
  symbol: string;
  tradingPeriods: Session[]; // sessions in which the rToken trades (from Reality stock-info)
  weekendTradable: boolean;
}

export interface HolidayClosure {
  start: number;
  end: number;
  label?: string;
}

export interface SessionInfo {
  session: Session;
  nyLocal: string; // "YYYY-MM-DD HH:mm" in America/New_York
  weekday: number; // 0 = Sunday … 6 = Saturday (NY local)
}

export interface Quantiles3 {
  p10: number;
  p50: number;
  p90: number;
}

export interface DepthBand {
  p10: number;
  p50: number;
}

export interface Resilience {
  halfLifeSec: number;
  lo: number;
  hi: number;
  n: number;
  censored?: number; // events not recovered within the censoring horizon (counted at the horizon)
  persistence?: number; // lag-1 autocorrelation of log depth; ~0 means depth has no memory
}

export interface LiquidityStats {
  symbol: string;
  venue: Venue;
  session: Session;
  n: number;
  from: number;
  to: number;
  spreadBps: Quantiles3;
  depthUsd: { b10: DepthBand; b25: DepthBand; b50: DepthBand };
  resilience: Resilience | null;
  sigmaBpsPerSqrtSec: number;
  tradeNotionalPerMin: { p50: number; mean: number };
  touchHitRatePerMin: number;
  medianTradeQty: number;
  representativeBook?: Book;
}

export type Atlas = Record<string, LiquidityStats>; // key: `${symbol}|${venue}|${session}`

export const atlasKey = (symbol: string, venue: Venue, session: Session): string =>
  `${symbol}|${venue}|${session}`;

export type EventKind = "earnings" | "ex_dividend" | "split" | "macro" | "holiday";

export interface MarketEvent {
  kind: EventKind;
  symbol?: string; // undefined = market-wide
  ts: number; // event time (or start of the window)
  windowSec: number; // how long around ts execution should avoid
  label: string;
  source: string; // which data source produced it
}

export type SourceStatus = "live" | "cached" | "unavailable";

export interface SourceRef {
  id: string; // e.g. "bitget.spot.orderbook", "bitget-mcp.equity_calendar"
  status: SourceStatus;
  asOf: number | null; // when the data was observed
  since?: number; // for unavailable: since when
  detail?: string;
}

export interface MarketSnapshot {
  symbol: string;
  now: number;
  books: Partial<Record<Venue, Book>>;
  fees: Record<Venue, Fees>;
  funding: FundingInfo | null;
  sessions: SymbolSessions;
  holidays: HolidayClosure[];
  atlas: Atlas;
  events: MarketEvent[];
  indexComponents?: { source: string; price: number; weight: number }[];
  gapSigmaBps?: Partial<Record<string, number>>; // key: `${venue}|${fromSession}->${toSession}`
  basisSigmaBpsPerSqrtHour?: number;
  sources: SourceRef[];
}

export type Urgency = "patient" | "normal" | "urgent";

export interface Profile {
  name: string;
  urgency: Urgency;
  costCapBps: number;
  maxParticipation: number; // fraction of venue-native traded notional per slice interval
  allowPerp: boolean;
  maxLeverage: number;
  avoidSessions: Session[];
  avoidEvents: boolean;
  feeOverride?: Partial<Record<Venue, Fees>>; // VIP tier fees if the trader has them
}

export interface OrderIntent {
  symbol: string;
  side: Side;
  notionalUsd?: number;
  qty?: number;
  deadline?: number; // must be fully executed by
  holdHorizonHours?: number; // for perp-hold strategies
  venues?: Venue[]; // restrict venues
}

export type StrategyKind = "immediate" | "sliced" | "passive" | "wait" | "perp_then_rotate" | "perp_hold";

export interface Slice {
  t: number;
  venue: Venue;
  side: Side;
  qty: number;
  type: "market" | "limit";
  limitPx?: number;
  postOnly?: boolean;
  session: Session;
  expectedBps: number;
  conditional?: boolean; // only the unfilled remainder of the preceding passive slice is sent
  leg?: "entry" | "rotate_out" | "rotate_in";
}

// Expected parts (spread + impact + fees + funding = expectedBps) and sd parts
// (sdBps² = priceRisk² + gapRisk² + basisRisk² + nonFill²).
export interface CostComponents {
  spread: number;
  impact: number;
  fees: number;
  funding: number;
  gapRisk: number; // sd contribution, bps
  basisRisk: number; // sd contribution, bps
  nonFill: number; // sd contribution of the passive fill/no-fill lottery, bps
  priceRisk?: number; // sd contribution of the Almgren–Chriss execution interval, bps
}

export interface StrategyQuote {
  id: string; // deterministic, e.g. "sliced:rtoken:n6:t60"
  kind: StrategyKind;
  label: string;
  slices: Slice[];
  qty: number;
  notionalUsd: number;
  expectedBps: number;
  sdBps: number;
  p10Bps: number;
  p90Bps: number;
  score: number; // expected + λ·sd
  components: CostComponents;
  startsAt: number;
  endsAt: number;
  assumptions: string[];
  feasible?: boolean; // false = shown on the frontier but never chosen
  violations?: Violation[];
}

export type Violation =
  | "DEADLINE"
  | "BOOK_EXHAUSTED"
  | "VENUE_CLOSED"
  | "PROFILE"
  | "PARTICIPATION"
  | "EVENT_WINDOW";

export type CheckStatus = "pass" | "hold" | "refuse";

export type GateCode =
  | "DATA_STALE"
  | "VENUE_CLOSED"
  | "BOOK_EXHAUSTED"
  | "COST_CAP"
  | "PARTICIPATION"
  | "EVENT_WINDOW"
  | "PRICE_INTEGRITY"
  | "PROFILE"
  | "SOURCE_MISSING";

export interface GateCheck {
  code: GateCode;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export type Verdict = "allow" | "hold" | "refuse";

export interface GateResult {
  verdict: Verdict;
  checks: GateCheck[];
}

export interface Plan {
  intent: OrderIntent;
  profileName: string;
  arrivalMid: number;
  strategy: StrategyQuote;
  createdAt: number;
  modelVersion: string;
  sources: SourceRef[];
}

export interface SignedPlan {
  plan: Plan;
  gate: GateResult;
  hash: string; // sha256 hex of canonical JSON of {plan, gate}
  sig: string; // Ed25519 signature (base64) of utf8 `slipway-plan-v1:${hash}:${issuedAt}` (binds the issue time)
  pubkey: string; // base64 raw public key
  issuedAt: number;
}
