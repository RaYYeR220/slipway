import type { LiquidityStats } from "@slipway/core";
import type { AtlasDoc } from "../site/data";

export const UNIVERSE = [
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "META",
  "AMD",
  "MU",
  "INTC",
  "MSTR",
  "COIN",
  "CRCL",
  "HOOD",
  "PLTR",
  "SPY",
  "QQQ",
  "SOXL",
];

export function symbolsOf(doc: AtlasDoc): string[] {
  const seen = new Set(Object.values(doc.atlas).map((s) => s.symbol));
  return [...UNIVERSE.filter((s) => seen.has(s)), ...[...seen].filter((s) => !UNIVERSE.includes(s)).sort()];
}

export function venueStats(
  doc: AtlasDoc,
  symbol: string,
  venue: string,
): Partial<Record<string, LiquidityStats>> {
  const out: Partial<Record<string, LiquidityStats>> = {};
  for (const s of Object.values(doc.atlas)) if (s.symbol === symbol && s.venue === venue) out[s.session] = s;
  return out;
}

export interface Flag {
  type: string;
  symbol: string | null;
  key: string;
  text: string;
}

export function parseFlags(doc: AtlasDoc): Flag[] {
  return (doc.flags ?? []).map((f) => {
    const sp = f.indexOf(" ");
    const type = sp > 0 ? f.slice(0, sp) : f;
    const rest = sp > 0 ? f.slice(sp + 1) : "";
    const colon = rest.indexOf(": ");
    const key = colon > 0 ? rest.slice(0, colon) : "";
    const text = colon > 0 ? rest.slice(colon + 2) : rest;
    const head = key.split(/[|\s]/)[0] ?? "";
    const symbol = /^[A-Z]{1,6}$/.test(head) ? head : null;
    return { type, symbol, key, text };
  });
}

export const FLAG_INFO: Record<string, { title: string; text: string }> = {
  RTOKEN_TAPE_SILENT: {
    title: "rToken public tape is silent",
    text: "Routed rToken fills do not print on Bitget’s public trade feed, so trade flow and touch-hit rates for rTokens are public-print rates. They are reported as measured, not imputed.",
  },
  RTOKEN_VOLUME_MIRROR: {
    title: "rToken volume mirrors the US tape",
    text: "The rToken’s 24-hour turnover reports US consolidated volume; Bitget-native turnover is far smaller. Slipway never uses the mirrored number as Bitget liquidity.",
  },
  GAP_SIGMA_THIN: {
    title: "Too few session gaps to measure",
    text: "Gap risk between two sessions needs enough historical transitions in 60 days of candles; thin pairs are omitted, never filled in.",
  },
  REALITY_LABEL_MISMATCH: {
    title: "Reality session label disagrees with New York time",
    text: "Bitget’s Reality states endpoint labels the clock EST during daylight time. Slipway derives sessions from America/New_York itself.",
  },
  METHOD: {
    title: "Method",
    text: "How the atlas is built.",
  },
};

export const flagTitle = (t: string) => FLAG_INFO[t]?.title ?? t.replaceAll("_", " ").toLowerCase();
