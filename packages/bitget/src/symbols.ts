import type { Venue } from "@slipway/core";

export type InstType = "SPOT" | "USDT-FUTURES";

/** rToken spot symbol, e.g. NVDA -> RNVDAUSDT. */
export const spotSymbol = (underlying: string): string => `R${underlying.toUpperCase()}USDT`;

/** USDT-M stock perp symbol, e.g. NVDA -> NVDAUSDT. */
export const perpSymbol = (underlying: string): string => `${underlying.toUpperCase()}USDT`;

export const exchangeSymbol = (venue: Venue, underlying: string): string =>
  venue === "rtoken" ? spotSymbol(underlying) : perpSymbol(underlying);

export const instTypeOf = (venue: Venue): InstType => (venue === "rtoken" ? "SPOT" : "USDT-FUTURES");

export const venueOfInstType = (instType: string): Venue | null =>
  instType.toUpperCase() === "SPOT" ? "rtoken" : instType.toUpperCase() === "USDT-FUTURES" ? "perp" : null;

/** Underlying ticker from an exchange symbol; the venue disambiguates tickers that start with "R". */
export function underlyingOf(venue: Venue, symbol: string): string {
  const s = symbol.toUpperCase();
  if (!s.endsWith("USDT")) throw new Error(`not a USDT symbol: ${symbol}`);
  const base = s.slice(0, -4);
  if (venue === "perp") return base;
  if (!base.startsWith("R")) throw new Error(`not an rToken symbol: ${symbol}`);
  return base.slice(1);
}

/** ccxt-style unified perp symbol used by the MCP catalogs, e.g. NVDA/USDT:USDT. */
export const ccxtPerpSymbol = (underlying: string): string => `${underlying.toUpperCase()}/USDT:USDT`;
