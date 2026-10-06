import type { Fees, Side, SourceRef } from "@slipway/core";

/** A value together with the provenance of the call that produced it. */
export interface Sourced<T> {
  data: T;
  source: SourceRef;
  latencyMs: number;
}

/** Same as Sourced, but `data` is null when the source could not deliver (never a fabricated default). */
export interface Optional<T> {
  data: T | null;
  source: SourceRef;
  latencyMs: number;
}

export type IntegritySeverity = "info" | "warn";

/** A data-quality observation about a source, surfaced to the UI and the gate instead of silently "fixed". */
export interface IntegrityFlag {
  code: string;
  source: string;
  severity: IntegritySeverity;
  detail: string;
}

export interface Trade {
  id: string;
  ts: number;
  px: number;
  sz: number;
  side: Side;
}

export interface Candle {
  ts: number; // bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base units
  quoteVolume: number | null; // USDT, when the endpoint reports it
}

export type CandleInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export interface SpotTicker {
  symbol: string;
  ts: number;
  last: number;
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
  volume24h: number;
  turnover24h: number;
  /** Bitget-native traded notional; `turnover24h` mirrors the routed US-market volume for rTokens. */
  platformTurnover24h: number | null;
}

export interface PerpTicker {
  symbol: string;
  ts: number;
  last: number;
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  turnover24h: number;
}

/** Exchange trading rules needed to turn a slice into a valid order. */
export interface InstrumentRules {
  symbol: string;
  pricePlace: number;
  priceTick: number;
  qtyPlace: number;
  qtyStep: number;
  minQty: number;
  minNotional: number;
  quotePlace: number;
  buyLimitPriceRatio: number | null;
  sellLimitPriceRatio: number | null;
  /** Per-order venue maxima (perp maxMarketOrderQty / maxOrderQty, rToken maxMarketOrderValue / maxLimitOrderValue). */
  maxMarketQty: number | null;
  maxMarketNotional: number | null;
  maxLimitQty: number | null;
  maxLimitNotional: number | null;
}

export interface SpotSymbolInfo {
  symbol: string;
  baseCoin: string;
  status: string;
  fees: Fees;
  rules: InstrumentRules;
  areaSymbol: boolean;
}

export interface PerpContractInfo {
  symbol: string;
  status: string;
  fees: Fees;
  rules: InstrumentRules;
  fundIntervalHours: number;
  isRwa: boolean;
  maxLeverage: number;
}

export interface CurrentFunding {
  symbol: string;
  rate: number;
  intervalHours: number;
  nextFundingTime: number;
  minRate: number | null;
  maxRate: number | null;
  /** v3 only: per-share cash dividend the perp will settle through funding, when announced. */
  cashDividend: number | null;
  cashDividendTime: number | null;
}

export interface FundingPoint {
  ts: number;
  rate: number;
}

export interface IndexComponent {
  source: string;
  pair: string;
  price: number;
  weight: number;
}

export interface MarketStateWindow {
  state: string;
  start: string; // "HH:mm" wall clock as published
  end: string;
  timeZoneLabel: string;
}

export interface MarketStates {
  market: string;
  daylightTypeLabel: string;
  windows: MarketStateWindow[];
  flags: IntegrityFlag[];
}

export interface RealityCalendar {
  timeZoneLabel: string;
  closures: { start: number; end: number; label?: string; startLocal: string; endLocal: string }[];
  weeklyClosedDays: string[];
  flags: IntegrityFlag[];
}

export interface WsTicker {
  symbol: string;
  ts: number;
  last: number;
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
}
