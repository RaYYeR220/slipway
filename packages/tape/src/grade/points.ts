// derived/track-record-points.json: the latest graded forecasts and per-order baseline comparisons in a compact
// shape the site can plot directly (scatter of predicted vs realized, residuals, per-order TWAP comparison).
import type { Graded } from "./grade.js";
import type { OrderOutcomes } from "./report.js";

export const POINTS_MAX = 3000;
export const POINTS_MAX_BYTES = 1_000_000;

const r2 = (x: number) => Math.round(x * 100) / 100;

export interface LabelSet {
  shadow: number; // REPRODUCIBLE
  modeled?: number; // MODELED, when it differs from shadow
  bound?: number; // BOUND, when it differs from shadow
}

export interface Point {
  id: string;
  symbol: string;
  venue: string;
  session: string;
  family: string;
  scope: "order" | "slice";
  horizonSec: number;
  registeredAt: number;
  at: number;
  predicted: { p50: number; p10?: number; p90?: number };
  realized: LabelSet;
}

export interface HeadToHeadRow {
  orderId: string; // batchId:index
  symbol: string;
  sizeUsd: number;
  session: string;
  registeredAt: number;
  chosenStrategy: string;
  chosen: LabelSet;
  immediate: LabelSet;
  twap60?: LabelSet;
}

export interface PointsDoc {
  generatedAt: number;
  units: string;
  points: Point[];
  headToHead: HeadToHeadRow[];
}

function labels(g: Graded | null): LabelSet | null {
  const r = g?.status === "graded" ? g.realized : undefined;
  if (!r || r.REPRODUCIBLE === null) return null;
  const out: LabelSet = { shadow: r2(r.REPRODUCIBLE) };
  if (r.MODELED !== null && r2(r.MODELED) !== out.shadow) out.modeled = r2(r.MODELED);
  if (r.BOUND !== null && r2(r.BOUND) !== out.shadow) out.bound = r2(r.BOUND);
  return out;
}

export function toPoint(g: Graded): Point | null {
  const realized = labels(g);
  if (!realized) return null;
  const predicted: Point["predicted"] = { p50: r2(g.p50) };
  if (g.p10 !== undefined) predicted.p10 = r2(g.p10);
  if (g.p90 !== undefined) predicted.p90 = r2(g.p90);
  return {
    id: g.id,
    symbol: g.symbol,
    venue: g.venue,
    session: g.session,
    family: g.family,
    scope: g.scope,
    horizonSec: Math.round(((g.scope === "order" ? g.until : g.at) - g.registeredAt) / 100) / 10,
    registeredAt: g.registeredAt,
    at: g.at,
    predicted,
    realized,
  };
}

/** Keeps the newest graded rows per scope while the ledger is streamed in chain order. */
export class LatestGraded {
  private readonly rows: Record<"order" | "slice", Graded[]> = { order: [], slice: [] };
  constructor(private readonly perScope = POINTS_MAX / 2) {}
  push(g: Graded): void {
    if (g.status !== "graded" || g.realized?.REPRODUCIBLE === null) return;
    const xs = this.rows[g.scope];
    xs.push(g);
    if (xs.length > this.perScope * 2) xs.splice(0, xs.length - this.perScope);
  }
  latest(): Graded[] {
    return [...this.rows.order.slice(-this.perScope), ...this.rows.slice.slice(-this.perScope)];
  }
}

export function headToHeadRows(outcomes: readonly OrderOutcomes[]): HeadToHeadRow[] {
  const out: HeadToHeadRow[] = [];
  for (const o of outcomes) {
    const chosen = labels(o.chosen);
    const immediate = labels(o.immediate);
    if (!chosen || !immediate || !o.chosen) continue;
    const row: HeadToHeadRow = {
      orderId: o.key,
      symbol: o.symbol,
      sizeUsd: o.notionalUsd,
      session: o.session,
      registeredAt: o.chosen.registeredAt,
      chosenStrategy: o.chosen.strategyId,
      chosen,
      immediate,
    };
    const twap = labels(o.twap60);
    if (twap) row.twap60 = twap;
    out.push(row);
  }
  return out.sort((a, b) => b.registeredAt - a.registeredAt || a.orderId.localeCompare(b.orderId));
}

/** Newest first; trimmed (oldest dropped) until the serialized document is under the size budget. */
export function pointsDoc(
  generatedAt: number,
  graded: readonly Graded[],
  rows: readonly HeadToHeadRow[],
  maxBytes = POINTS_MAX_BYTES,
): PointsDoc {
  let points = graded
    .map(toPoint)
    .filter((p): p is Point => p !== null)
    .sort((a, b) => b.registeredAt - a.registeredAt || a.id.localeCompare(b.id))
    .slice(0, POINTS_MAX);
  let h2h = [...rows];
  const units =
    "bps of each venue's arrival mid, fees included; positive = cost. shadow = REPRODUCIBLE, modeled = MODELED, bound = BOUND (omitted when equal to shadow)";
  for (;;) {
    const doc: PointsDoc = { generatedAt, units, points, headToHead: h2h };
    if (JSON.stringify(doc).length < maxBytes || (points.length === 0 && h2h.length === 0)) return doc;
    points = points.slice(0, Math.floor(points.length * 0.9));
    h2h = h2h.slice(0, Math.floor(h2h.length * 0.9));
  }
}
