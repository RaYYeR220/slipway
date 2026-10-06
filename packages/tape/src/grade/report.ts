// Track record: accuracy by venue × session × horizon, p10–p90 coverage, head-to-head against the baselines with
// seeded bootstrap CIs, out-of-sample calibration, and the list of cases where Slipway loses.
import { mean } from "@slipway/core";
import { mulberry32 } from "../eval/protocol.js";
import type { Graded } from "./grade.js";
import { HORIZONS, LABELS, type Label } from "./realize.js";

export interface AccuracyRow {
  scope: "order" | "slice";
  venue: string;
  session: string;
  horizon: string;
  n: number;
  maeBps: number;
  biasBps: number; // mean(predicted − realized): positive = forecasts too pessimistic
  coverage?: { n: number; inside: number; rate: number }; // order scope: realized within [p10, p90]
}

export interface Comparison {
  n: number;
  wins: number; // Slipway's chosen plan cost less
  losses: number;
  ties: number;
  winRate: number;
  meanDiffBps: number; // mean(chosen − baseline): negative = Slipway cheaper
  ci95: [number, number];
}

export interface CalibrationRow {
  venue: string;
  session: string;
  evalN: number; // forecasts evaluated with a factor fitted only on outcomes known before they were registered
  k: number; // factor fitted on all graded outcomes so far (shrunk toward 1, n0 = 20)
  maeRawBps: number;
  maeCalibratedBps: number;
}

export interface LossRow {
  comparison: string;
  group: string;
  n: number;
  meanDiffBps: number;
  ci95: [number, number];
}

export const BOOTSTRAP_RESAMPLES = 2000;
export const CALIBRATION_N0 = 20;

/** Percentile bootstrap CI of the mean (seeded mulberry32, so the published interval is reproducible). */
export function bootstrapMeanCi(
  xs: readonly number[],
  seed: number,
  resamples = BOOTSTRAP_RESAMPLES,
): [number, number] {
  if (xs.length === 0) return [Number.NaN, Number.NaN];
  const rand = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rand() * xs.length)] as number;
    means[b] = s / xs.length;
  }
  means.sort();
  const q = (p: number) =>
    means[Math.min(resamples - 1, Math.max(0, Math.round(p * (resamples - 1))))] as number;
  return [q(0.025), q(0.975)];
}

/** Streaming accumulator of MAE / bias / band coverage per scope × venue × session × horizon. */
export class AccuracyAccumulator {
  private readonly groups = new Map<
    string,
    { n: number; abs: number; sum: number; bn: number; inside: number }
  >();
  constructor(readonly label: Label) {}

  add(g: Graded): void {
    const r = g.status === "graded" ? g.realized?.[this.label] : null;
    if (r === null || r === undefined) return;
    const k = `${g.scope}|${g.venue}|${g.session}|${g.horizon}`;
    let a = this.groups.get(k);
    if (!a) {
      a = { n: 0, abs: 0, sum: 0, bn: 0, inside: 0 };
      this.groups.set(k, a);
    }
    const err = g.p50 - r;
    a.n++;
    a.abs += Math.abs(err);
    a.sum += err;
    if (g.scope === "order" && g.p10 !== undefined && g.p90 !== undefined) {
      a.bn++;
      if (r >= g.p10 && r <= g.p90) a.inside++;
    }
  }

  rows(): AccuracyRow[] {
    const h = (x: string) => HORIZONS.indexOf(x as (typeof HORIZONS)[number]);
    return [...this.groups]
      .map(([k, a]) => {
        const [scope, venue, session, horizon] = k.split("|") as [
          AccuracyRow["scope"],
          string,
          string,
          string,
        ];
        const row: AccuracyRow = {
          scope,
          venue,
          session,
          horizon,
          n: a.n,
          maeBps: a.abs / a.n,
          biasBps: a.sum / a.n,
        };
        if (a.bn) row.coverage = { n: a.bn, inside: a.inside, rate: a.inside / a.bn };
        return row;
      })
      .sort(
        (a, b) =>
          a.scope.localeCompare(b.scope) ||
          a.venue.localeCompare(b.venue) ||
          a.session.localeCompare(b.session) ||
          h(a.horizon) - h(b.horizon),
      );
  }
}

export function accuracy(rows: Iterable<Graded>, label: Label): AccuracyRow[] {
  const acc = new AccuracyAccumulator(label);
  for (const g of rows) acc.add(g);
  return acc.rows();
}

export interface OrderOutcomes {
  key: string; // batchId:order
  session: string;
  symbol: string;
  notionalUsd: number;
  chosen: Graded | null;
  immediate: Graded | null;
  twap60: Graded | null;
}

/** Order-scope rows of eval orders, keyed by protocol role. `primary` = the planner's baseline venue per order. */
export function orderOutcomes(
  rows: readonly Graded[],
  orders: readonly { key: string; session: string; symbol: string; notionalUsd: number; primary: string }[],
): OrderOutcomes[] {
  const byKey = new Map<string, Graded[]>();
  for (const g of rows) {
    if (g.scope !== "order" || g.batchId === undefined || g.order === undefined) continue;
    const k = `${g.batchId}:${g.order}`;
    byKey.set(k, [...(byKey.get(k) ?? []), g]);
  }
  return orders.map((o) => {
    const gs = byKey.get(o.key) ?? [];
    const role = (r: string) => gs.find((g) => g.roles?.includes(r)) ?? null;
    return {
      ...o,
      chosen: role("chosen"),
      immediate: role(`immediate:${o.primary}`),
      twap60: role(`twap60:${o.primary}`),
    };
  });
}

const realizedOf = (g: Graded | null, label: Label): number | null =>
  g && g.status === "graded" ? (g.realized?.[label] ?? null) : null;

export function compare(
  outcomes: readonly OrderOutcomes[],
  baseline: "immediate" | "twap60",
  label: Label,
  seed: number,
): { all: Comparison; diffs: { o: OrderOutcomes; d: number }[] } {
  const diffs: { o: OrderOutcomes; d: number }[] = [];
  for (const o of outcomes) {
    const c = realizedOf(o.chosen, label);
    const b = realizedOf(o[baseline], label);
    if (c === null || b === null) continue;
    diffs.push({ o, d: c - b });
  }
  return {
    all: summarize(
      diffs.map((x) => x.d),
      seed,
    ),
    diffs,
  };
}

export function summarize(ds: readonly number[], seed: number): Comparison {
  const eps = 1e-9;
  const wins = ds.filter((d) => d < -eps).length;
  const losses = ds.filter((d) => d > eps).length;
  return {
    n: ds.length,
    wins,
    losses,
    ties: ds.length - wins - losses,
    winRate: ds.length ? wins / ds.length : Number.NaN,
    meanDiffBps: mean(ds),
    ci95: bootstrapMeanCi(ds, seed),
  };
}

/** Groups (by session, size, symbol and overall) where the chosen plan cost more than the baseline on average. */
export function lossesOf(
  diffs: readonly { o: OrderOutcomes; d: number }[],
  comparison: string,
  seed: number,
): LossRow[] {
  const groups = new Map<string, number[]>();
  const add = (g: string, d: number) => groups.set(g, [...(groups.get(g) ?? []), d]);
  for (const { o, d } of diffs) {
    add("all", d);
    add(`session=${o.session}`, d);
    add(`size=$${o.notionalUsd}`, d);
    add(`symbol=${o.symbol}`, d);
  }
  const out: LossRow[] = [];
  for (const [group, ds] of groups) {
    const m = mean(ds);
    if (m > 1e-9)
      out.push({ comparison, group, n: ds.length, meanDiffBps: m, ci95: bootstrapMeanCi(ds, seed) });
  }
  return out.sort((a, b) => b.meanDiffBps - a.meanDiffBps);
}

/**
 * Multiplicative calibration per venue × session on order-scope p50: a forecast is calibrated with the factor fitted
 * on outcomes realized before it was registered (k = (Σ r·p + n0·p̄²) / (Σ p² + n0·p̄²), i.e. least squares shrunk
 * toward 1 with n0 pseudo-observations), so every evaluated forecast is out of sample in time.
 */
export function calibration(rows: readonly Graded[], label: Label, n0 = CALIBRATION_N0): CalibrationRow[] {
  const groups = new Map<string, Graded[]>();
  for (const g of rows) {
    if (g.scope !== "order" || g.status !== "graded" || realizedOf(g, label) === null) continue;
    const k = `${g.venue}|${g.session}`;
    groups.set(k, [...(groups.get(k) ?? []), g]);
  }
  const out: CalibrationRow[] = [];
  for (const [k, gs] of groups) {
    const [venue, session] = k.split("|") as [string, string];
    const byReg = [...gs].sort((a, b) => a.registeredAt - b.registeredAt);
    const byOutcome = [...gs].sort((a, b) => a.until - b.until);
    const fit = (known: Graded[]) => {
      const pp = known.reduce((s, g) => s + g.p50 * g.p50, 0);
      const rp = known.reduce((s, g) => s + g.p50 * (realizedOf(g, label) as number), 0);
      const pbar2 = known.length ? pp / known.length : 0;
      return pp + n0 * pbar2 > 0 ? (rp + n0 * pbar2) / (pp + n0 * pbar2) : 1;
    };
    const raw: number[] = [];
    const cal: number[] = [];
    let j = 0;
    for (const g of byReg) {
      while (j < byOutcome.length && (byOutcome[j] as Graded).until + 5_000 < g.registeredAt) j++;
      if (j === 0) continue;
      const k1 = fit(byOutcome.slice(0, j));
      const r = realizedOf(g, label) as number;
      raw.push(Math.abs(g.p50 - r));
      cal.push(Math.abs(k1 * g.p50 - r));
    }
    out.push({
      venue,
      session,
      evalN: raw.length,
      k: fit(byOutcome),
      maeRawBps: raw.length ? mean(raw) : Number.NaN,
      maeCalibratedBps: cal.length ? mean(cal) : Number.NaN,
    });
  }
  return out.sort((a, b) => a.venue.localeCompare(b.venue) || a.session.localeCompare(b.session));
}

export function ungradedReasons(rows: readonly Graded[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of rows)
    if (g.status === "ungraded") out[g.reason ?? "unknown"] = (out[g.reason ?? "unknown"] ?? 0) + 1;
  return out;
}

export { LABELS };
