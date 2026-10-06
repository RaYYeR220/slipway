// Source ablation ("effectiveness"): replay the planner on each batch's saved snapshot with one source removed
// (falling back to the documented default) and measure how often the chosen strategy changes and what the
// replacement would have cost on the recorded tape.
import {
  type Atlas,
  type MarketSnapshot,
  type OrderIntent,
  type Profile,
  planExecution,
  type StrategyQuote,
} from "@slipway/core";

export interface Ablation {
  source: string;
  fallback: string;
  apply: (s: MarketSnapshot) => MarketSnapshot;
}

const mapAtlas = (s: MarketSnapshot, f: (v: Atlas[string]) => Atlas[string]): MarketSnapshot => ({
  ...s,
  atlas: Object.fromEntries(Object.entries(s.atlas).map(([k, v]) => [k, f(v)])),
});

export const ABLATIONS: Ablation[] = [
  {
    source: "bitget.spot.orderbook",
    fallback: "no live rToken book: rToken strategies are not priced",
    apply: (s) => ({ ...s, books: { ...(s.books.perp ? { perp: s.books.perp } : {}) } }),
  },
  {
    source: "bitget.mix.orderbook",
    fallback: "no live perp book: perp and rotation strategies are not priced",
    apply: (s) => ({ ...s, books: { ...(s.books.rtoken ? { rtoken: s.books.rtoken } : {}) } }),
  },
  {
    source: "atlas.resilience",
    fallback: "prior depth half-life (60 s) everywhere",
    apply: (s) => mapAtlas(s, (v) => ({ ...v, resilience: null })),
  },
  {
    source: "atlas.flow",
    fallback: "no recorded prints: participation cap waived, passive fill probability 0",
    apply: (s) =>
      mapAtlas(s, (v) => ({
        ...v,
        tradeNotionalPerMin: { p50: 0, mean: 0 },
        touchHitRatePerMin: 0,
        medianTradeQty: 0,
      })),
  },
  {
    source: "atlas.representativeBook",
    fallback: "no representative book: strategies executing in another session are not priced",
    apply: (s) =>
      mapAtlas(s, (v) => {
        const { representativeBook: _, ...rest } = v;
        return rest;
      }),
  },
  {
    source: "atlas.gapSigma",
    fallback: "waits priced with integrated session σ",
    apply: (s) => {
      const { gapSigmaBps: _, ...rest } = s;
      return rest;
    },
  },
  {
    source: "atlas.basisSigma",
    fallback: "perp-then-rotate is not priced",
    apply: (s) => {
      const { basisSigmaBpsPerSqrtHour: _, ...rest } = s;
      return rest;
    },
  },
  {
    source: "bitget.mix.funding",
    fallback: "perp positions held across a settlement are not priced",
    apply: (s) => ({ ...s, funding: null }),
  },
  {
    source: "events (bitget-mcp calendars, signal macro, perp dividends)",
    fallback: "no event windows",
    apply: (s) => ({ ...s, events: [] }),
  },
  {
    source: "bitget.reality.calendar",
    fallback: "no holiday closures",
    apply: (s) => ({ ...s, holidays: [] }),
  },
];

export interface AblationReplay {
  source: string;
  chosen: StrategyQuote | null;
  error?: string;
}

/** Chosen strategy with every source present (must reproduce the registered choice) and with each one removed. */
export function replayAblations(
  snap: MarketSnapshot,
  intent: OrderIntent,
  profile: Profile,
): { baseline: StrategyQuote | null; replays: AblationReplay[] } {
  const run = (s: MarketSnapshot): AblationReplay => {
    try {
      return { source: "", chosen: planExecution(intent, profile, s).best };
    } catch (e) {
      return { source: "", chosen: null, error: (e as Error).message };
    }
  };
  return {
    baseline: run(snap).chosen,
    replays: ABLATIONS.map((a) => ({ ...run(a.apply(snap)), source: a.source })),
  };
}
