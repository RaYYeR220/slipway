// Record shapes written by the recorder (tape/recorder.mjs) and their conversion to core types.
import { type Book, bookFromBitget, type Side, type TapeTrade, type Venue } from "@slipway/core";

export type InstType = "SPOT" | "USDT-FUTURES";
type RawLevel = [string, string];

export interface BookRecord {
  instType: InstType;
  instId: string;
  ts: number;
  rx: number;
  asks: RawLevel[];
  bids: RawLevel[];
}

export interface TradeRecord {
  instType: InstType;
  instId: string;
  rx: number;
  ts: number;
  px: string;
  sz: string;
  side: Side;
  id: string;
}

export interface TickerRecord {
  instType: InstType;
  instId: string;
  rx: number;
  ts: number;
  last: string;
  bid: string;
  ask: string;
  mark: string;
  index: string;
  funding: string;
  nextFunding: string;
}

export const instId = (venue: Venue, symbol: string): string =>
  venue === "rtoken" ? `R${symbol}USDT` : `${symbol}USDT`;
export const instType = (venue: Venue): InstType => (venue === "rtoken" ? "SPOT" : "USDT-FUTURES");

/** Cheap pre-parse line filter for one instrument (instId values are distinct across the two venues). */
export const lineFor = (venue: Venue, symbol: string): string => `"instId":"${instId(venue, symbol)}"`;

export const toBook = (r: BookRecord): Book => bookFromBitget(r);

export const toTrade = (r: TradeRecord): TapeTrade => ({
  ts: r.ts,
  px: Number(r.px),
  sz: Number(r.sz),
  side: r.side,
});

export function venueOf(r: { instType: string }): Venue | null {
  return r.instType === "SPOT" ? "rtoken" : r.instType === "USDT-FUTURES" ? "perp" : null;
}

export function symbolOf(r: { instType: string; instId: string }): string | null {
  const v = venueOf(r);
  if (v === "rtoken") return /^R([A-Z0-9.]+)USDT$/.exec(r.instId)?.[1] ?? null;
  if (v === "perp") return /^([A-Z0-9.]+)USDT$/.exec(r.instId)?.[1] ?? null;
  return null;
}
