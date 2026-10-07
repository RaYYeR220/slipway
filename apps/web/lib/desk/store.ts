// Canvas state: the latest market, tide, options, plan and tickets, whether they came from the conversation or
// the order line, plus the evidence ledger of every source observed this session.
import type { ApiFailure, DeskState, Held, Loadable, SourceRef } from "./types";

export const initialState = (symbol = "NVDA"): DeskState => ({
  symbol,
  market: null,
  tide: null,
  research: null,
  options: null,
  plan: null,
  tickets: null,
  busy: {},
  errors: {},
  sources: {},
  seen: {},
});

type HeldKey = "market" | "tide" | "research" | "options" | "plan" | "tickets";

export type DeskAction =
  | { type: "symbol"; symbol: string }
  | { type: "busy"; key: Loadable; label: string | null }
  | { type: "held"; key: HeldKey; held: Held<unknown>; via: string }
  | { type: "error"; key: Loadable; error: ApiFailure | null }
  | { type: "seen"; callId: string }
  | { type: "sources"; sources: SourceRef[]; via: string }
  | { type: "reset-order" };

function mergeSources(
  ledger: DeskState["sources"],
  sources: SourceRef[],
  via: string,
  at: number,
): DeskState["sources"] {
  if (!sources.length) return ledger;
  const next = { ...ledger };
  for (const ref of sources) {
    const prev = next[ref.id];
    // Keep the freshest observation; an unavailable report replaces an older live one only if it is newer.
    const prevAt = prev ? (prev.ref.asOf ?? prev.ref.since ?? prev.seenAt) : -1;
    const at2 = ref.asOf ?? ref.since ?? at;
    if (!prev || at2 >= prevAt) next[ref.id] = { ref, seenAt: at, via };
  }
  return next;
}

const symbolOf = (held: Held<unknown>): string | null => {
  const d = held.data as { symbol?: unknown; intent?: { symbol?: unknown } } | null;
  if (typeof d?.symbol === "string") return d.symbol;
  if (typeof d?.intent?.symbol === "string") return d.intent.symbol;
  return null;
};

export function deskReducer(state: DeskState, a: DeskAction): DeskState {
  switch (a.type) {
    case "symbol": {
      const symbol = a.symbol.trim().toUpperCase();
      if (!symbol || symbol === state.symbol) return state;
      return { ...state, symbol, market: null, tide: null, research: null };
    }
    case "busy": {
      const busy = { ...state.busy };
      if (a.label === null) delete busy[a.key];
      else busy[a.key] = a.label;
      return { ...state, busy };
    }
    case "error": {
      const errors = { ...state.errors };
      if (a.error === null) delete errors[a.key];
      else errors[a.key] = a.error;
      return { ...state, errors };
    }
    case "seen":
      return state.seen[a.callId] ? state : { ...state, seen: { ...state.seen, [a.callId]: true } };
    case "sources":
      return { ...state, sources: mergeSources(state.sources, a.sources, a.via, Date.now()) };
    case "reset-order":
      return { ...state, options: null, plan: null, tickets: null, errors: {} };
    case "held": {
      const errors = { ...state.errors };
      delete errors[a.key];
      const next: DeskState = {
        ...state,
        errors,
        sources: mergeSources(state.sources, a.held.sources, a.via, a.held.at),
      };
      const sym = symbolOf(a.held);
      switch (a.key) {
        case "options":
          next.options = a.held as DeskState["options"];
          // A new pricing run supersedes the plan and tickets that followed the previous one.
          next.plan = null;
          next.tickets = null;
          if (sym && sym !== state.symbol) {
            next.symbol = sym;
            next.market = null;
            next.tide = null;
            next.research = null;
          }
          break;
        case "plan":
          next.plan = a.held as DeskState["plan"];
          next.tickets = null;
          if (sym && sym !== state.symbol) next.symbol = sym;
          break;
        case "tickets":
          next.tickets = a.held as DeskState["tickets"];
          break;
        case "market":
          if (sym && sym !== state.symbol) return state;
          next.market = a.held as DeskState["market"];
          break;
        case "tide":
          if (sym && sym !== state.symbol) return state;
          next.tide = a.held as DeskState["tide"];
          break;
        case "research":
          if (sym && sym !== state.symbol) return state;
          next.research = a.held as DeskState["research"];
          break;
      }
      return next;
    }
  }
}
