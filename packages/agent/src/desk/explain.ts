// Plain-language glossary for the desk's components, strategies, gate checks and sources. Entries carry no
// figures of their own: any constant they mention is exposed as a slot read from the code that uses it.
import { GATE_DEFAULTS, LAMBDA, PLANNER_DEFAULTS } from "@slipway/core";
import type { SlotBag } from "./slots.js";

export const TICKET_MAX_AGE_MS = 60_000;

const CORE = "slipway.core";

interface Entry {
  title: string;
  text: string;
  slots?: (bag: SlotBag) => void;
}

export const GLOSSARY: Record<string, Entry> = {
  spread: {
    title: "Spread cost",
    text: "Half the bid-ask spread paid on every aggressive child order, measured against the arrival mid of the venue it trades on.",
  },
  impact: {
    title: "Impact",
    text: "Cost of walking the visible book beyond the touch. Earlier children leave a hole that refills with a measured half-life (transient impact), so later children start deeper in the book until it recovers.",
  },
  fees: {
    title: "Fees",
    text: "Bitget's published taker or maker fee for the venue, read from the exchange (or the profile's VIP override). Maker fees can be negative (a rebate).",
  },
  funding: {
    title: "Funding",
    text: "Perp legs held across a funding settlement pay or receive the current funding rate on their notional; the current rate is assumed to persist.",
  },
  gapRisk: {
    title: "Gap risk",
    text: "Standard deviation of the price move while waiting for a later session, from the historical spread of returns over the same session transition.",
  },
  basisRisk: {
    title: "Basis risk",
    text: "Uncertainty in the perp versus rToken price gap over the hold, for strategies that buy the perp now and rotate into the rToken later.",
  },
  nonFill: {
    title: "Non-fill risk",
    text: "A passive order may not fill; the remainder then crosses the spread at the end of the rest window. This is the spread of outcomes from that lottery.",
  },
  priceRisk: {
    title: "Price risk",
    text: "Almgren-Chriss timing risk: the longer unexecuted size stays open, the more the price can drift against it.",
  },
  immediate: { title: "Immediate", text: "One market order now on one venue." },
  sliced: {
    title: "Sliced",
    text: "Equal child orders at a fixed interval, so the book refills between children. Interval and count are searched over a grid within the participation cap and the deadline.",
  },
  twap_baseline: {
    title: "TWAP baseline",
    text: "What a Bitget-app style TWAP would do: fixed-size clips once a minute. Shown as the yardstick every plan is compared with.",
    slots: (b) => b.usd("twapClipUsd", PLANNER_DEFAULTS.twapChildNotionalUsd, CORE),
  },
  passive: {
    title: "Passive",
    text: "Rest at the touch for a while as a maker, then cross whatever is left. Cheaper if it fills, with non-fill risk if it does not.",
  },
  wait: {
    title: "Wait",
    text: "Do nothing until a later session (for example the regular open, skipping the opening minutes) and execute there, trading gap risk for a deeper book.",
    slots: (b) => b.put("openSkipMinutes", PLANNER_DEFAULTS.regularOpenSkipMin, "count", CORE),
  },
  perp_then_rotate: {
    title: "Perp then rotate",
    text: "Get exposure now on the stock perp, then sell the perp and buy the rToken in a later session. Only when the profile allows perps.",
  },
  perp_hold: {
    title: "Perp hold",
    text: "Hold the exposure on the perp for the stated horizon, paying funding instead of owning the rToken.",
  },
  urgency: {
    title: "Urgency",
    text: "The planner ranks strategies by expected cost plus lambda times uncertainty. Patient traders accept more uncertainty for a lower expected cost; urgent traders pay up for certainty.",
    slots: (b) =>
      b
        .put("lambdaPatient", LAMBDA.patient, "price", CORE, { dp: 2 })
        .put("lambdaNormal", LAMBDA.normal, "price", CORE, { dp: 2 })
        .put("lambdaUrgent", LAMBDA.urgent, "price", CORE, { dp: 2 }),
  },
  p10_p90: {
    title: "Cost band",
    text: "The cost band is the expected cost minus and plus a normal quantile times the standard deviation: most outcomes should land inside it, and the track record checks how often they do.",
  },
  bps: {
    title: "Basis points",
    text: "Costs are in basis points of the arrival mid; positive means it costs the trader.",
  },
  DATA_STALE: {
    title: "Data stale",
    text: "Refuses if the plan or a live book used for immediate children is older than the limit. Fix: re-plan on fresh data.",
    slots: (b) =>
      b
        .seconds("maxBookAge", GATE_DEFAULTS.maxBookAgeMs / 1000, CORE)
        .seconds("maxPlanAge", GATE_DEFAULTS.maxPlanAgeMs / 1000, CORE),
  },
  VENUE_CLOSED: {
    title: "Venue closed",
    text: "Refuses children scheduled when their venue does not trade (rTokens follow the Reality session calendar; perps trade around the clock). The fix names the next tradable session.",
  },
  BOOK_EXHAUSTED: {
    title: "Book exhausted",
    text: "Refuses if any child needs more than the visible book. The fix gives the largest size this shape can absorb.",
  },
  COST_CAP: {
    title: "Cost cap",
    text: "Refuses if expected cost exceeds the profile's cap. The fix gives the largest size under the cap and the best strategy that fits.",
  },
  PARTICIPATION: {
    title: "Participation",
    text: "Refuses children larger than the profile's share of the venue's own recorded traded flow over the child interval. The fix gives the spacing or child size that complies.",
  },
  EVENT_WINDOW: {
    title: "Event window",
    text: "Holds if earnings, an ex-dividend date, a split or (if the profile opts in) a macro release falls inside the execution window. The fix gives a window that avoids it.",
  },
  PRICE_INTEGRITY: {
    title: "Price integrity",
    text: "Holds if the perp index sources disagree or the rToken and perp mids diverge too far while both trade.",
    slots: (b) =>
      b
        .bps("maxIndexSpread", GATE_DEFAULTS.maxIndexSpreadBps, CORE)
        .bps("maxBasis", GATE_DEFAULTS.maxBasisBps, CORE),
  },
  PROFILE: {
    title: "Profile",
    text: "Refuses plans that use perps when the profile does not allow them, exceed its leverage, or trade in sessions it avoids.",
  },
  DEADLINE: {
    title: "Deadline",
    text: "Refuses plans whose last child order lands after the deadline the trader gave, and names the cheapest strategy that finishes in time.",
  },
  SOURCE_MISSING: {
    title: "Source missing",
    text: "Refuses when a critical input (a live book, session state, or the ability to price the plan) is unavailable. Optional sources degrade visibly instead.",
  },
  signed_plan: {
    title: "Signed plan",
    text: "The plan and its gate result are hashed and signed with the desk's EdDSA key. Tickets are only issued for an untampered plan with an ALLOW verdict, within a short window after signing.",
    slots: (b) => b.seconds("ticketWindow", TICKET_MAX_AGE_MS / 1000, CORE),
  },
  tickets: {
    title: "Dry-run tickets",
    text: "One order request per child, produced by Bitget's own agent SDK in dry-run mode with no credentials, plus the equivalent bgc command. Nothing is sent.",
  },
  atlas: {
    title: "Liquidity atlas",
    text: "Per symbol, venue and session statistics from the recorded Bitget tape: spread and depth quantiles, depth recovery half-life, volatility and traded flow. Strategies that need a future session's book or volatility are skipped when it is unavailable.",
  },
  track_record: {
    title: "Track record",
    text: "Every plan's cost forecast is registered in a hash-chained ledger before the fact and later graded against the book that actually printed, with wins and losses published.",
  },
  rtoken: {
    title: "rToken",
    text: "Bitget spot tokenized stock (R plus ticker, quoted in USDT), fully backed, trading in the Reality sessions.",
  },
  perp: {
    title: "Stock perp",
    text: "Bitget USDT-margined perpetual on the stock, trading around the clock, with periodic funding.",
  },
  sessions: {
    title: "Sessions",
    text: "New York pre-market, regular, after-hours and overnight sessions, plus the weekend; holidays close the rToken. Liquidity differs sharply between them.",
  },
};

export const TOPICS = Object.keys(GLOSSARY);

export function explainEntry(topic: string): { key: string; entry: Entry } | null {
  const t = topic.trim();
  const direct = GLOSSARY[t] ?? GLOSSARY[t.toUpperCase()];
  if (direct) return { key: GLOSSARY[t] ? t : t.toUpperCase(), entry: direct };
  const norm = t.toLowerCase().replace(/[\s-]+/g, "_");
  const key = TOPICS.find(
    (k) => k.toLowerCase() === norm || k.toLowerCase().replace(/_/g, "") === norm.replace(/_/g, ""),
  );
  return key ? { key, entry: GLOSSARY[key] as Entry } : null;
}
