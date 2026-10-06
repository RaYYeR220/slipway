import { canonicalJson, sha256Hex } from "./sign.js";
import type { Session, Side, SignedPlan, StrategyKind, Venue } from "./types.js";

// Forecast ledger: every plan (from a trader or from the pre-registered evaluation) is broken into
// entries that predict a cost before the tape that decides it has printed. Entries are hash-chained;
// the tape package stores them write-once and anchors Merkle roots on-chain.

export const LEDGER_VERSION = 1;
export const GENESIS_PREV = "0".repeat(64);

export type ForecastScope = "order" | "slice";

export interface ForecastBody {
  v: typeof LEDGER_VERSION;
  id: string;
  origin: "trader" | "eval";
  scope: ForecastScope;
  planHash: string;
  strategyId: string;
  family: StrategyKind;
  symbol: string;
  side: Side;
  venue: Venue | "mixed";
  qty: number; // order: parent qty; slice: slice qty
  at: number; // order: first slice time; slice: slice time
  until: number; // order: last slice time; slice: = at
  session: Session;
  arrivalMid: number;
  predicted: { p50: number; p10?: number; p90?: number }; // bps vs arrival mid, fees included
  modelVersion: string;
  registeredAt: number;
}

export interface ForecastEntry extends ForecastBody {
  prevHash: string;
  hash: string;
}

/** Forecasts implied by a signed plan: one order-level entry with its band, one entry per firm slice. */
export function forecastsFromPlan(
  signed: SignedPlan,
  origin: ForecastBody["origin"],
  registeredAt: number,
): ForecastBody[] {
  const { plan, hash } = signed;
  const q = plan.strategy;
  const slices = q.slices;
  const first = slices[0];
  const last = slices[slices.length - 1];
  if (!first || !last) return [];
  const venues = new Set(slices.map((s) => s.venue));
  const base = {
    v: LEDGER_VERSION,
    origin,
    planHash: hash,
    strategyId: q.id,
    family: q.kind,
    symbol: plan.intent.symbol,
    side: plan.intent.side,
    arrivalMid: plan.arrivalMid,
    modelVersion: plan.modelVersion,
    registeredAt,
  } as const;
  const out: ForecastBody[] = [
    {
      ...base,
      id: `${hash.slice(0, 16)}:order`,
      scope: "order",
      venue: venues.size === 1 ? first.venue : "mixed",
      qty: q.qty,
      at: first.t,
      until: last.t,
      session: first.session,
      predicted: { p50: q.expectedBps, p10: q.p10Bps, p90: q.p90Bps },
    },
  ];
  slices.forEach((s, i) => {
    if (s.conditional) return; // size depends on an unobservable passive fill
    out.push({
      ...base,
      id: `${hash.slice(0, 16)}:${i}`,
      scope: "slice",
      venue: s.venue,
      side: s.side,
      qty: s.qty,
      at: s.t,
      until: s.t,
      session: s.session,
      predicted: { p50: s.expectedBps },
    });
  });
  return out;
}

export const entryHash = (body: ForecastBody, prevHash: string): Promise<string> =>
  sha256Hex(canonicalJson({ ...body, prevHash }));

/** Appends bodies to a chain that currently ends at `prevHash`. */
export async function chainForecasts(prevHash: string, bodies: ForecastBody[]): Promise<ForecastEntry[]> {
  const out: ForecastEntry[] = [];
  let prev = prevHash;
  for (const body of bodies) {
    const hash = await entryHash(body, prev);
    out.push({ ...body, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

/** Index of the first entry whose link or hash is wrong, or -1 if the chain is intact. */
export async function verifyChain(entries: ForecastEntry[], prevHash = GENESIS_PREV): Promise<number> {
  let prev = prevHash;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as ForecastEntry;
    const { hash, prevHash: link, ...body } = e;
    if (link !== prev || (await entryHash(body, link)) !== hash) return i;
    prev = hash;
  }
  return -1;
}
