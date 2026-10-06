import type { Quantiles3 } from "./types.js";

export const Z90 = 1.2815515655446004;
const MAD_TO_SIGMA = 1.4826;

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

function quantileSorted(s: readonly number[], p: number): number {
  if (s.length === 0) return Number.NaN;
  const h = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const a = s[lo] as number;
  const b = s[Math.min(lo + 1, s.length - 1)] as number;
  return a + (b - a) * (h - lo);
}

// Linear interpolation between order statistics (R type 7 / numpy default).
export function quantile(xs: readonly number[], p: number): number {
  return quantileSorted(sorted(xs), p);
}

export function quantiles3(xs: readonly number[]): Quantiles3 {
  const s = sorted(xs);
  return { p10: quantileSorted(s, 0.1), p50: quantileSorted(s, 0.5), p90: quantileSorted(s, 0.9) };
}

export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export const madSigma = (xs: readonly number[]): number => MAD_TO_SIGMA * mad(xs);

// RMS after clipping at max(5 MAD-sigmas, 99th pct of |x|): survives glitches and zero-inflated tick data.
export function robustRms(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const clip = Math.max(5 * madSigma(xs), quantile(xs.map(Math.abs), 0.99));
  let s = 0;
  for (const x of xs) {
    const c = Math.min(Math.abs(x), clip);
    s += c * c;
  }
  return Math.sqrt(s / xs.length);
}

export function lag1Autocorrelation(xs: readonly number[]): number {
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = (xs[i] as number) - m;
    den += d * d;
    if (i > 0) num += d * ((xs[i - 1] as number) - m);
  }
  return den > 0 ? num / den : Number.NaN;
}

// P(N >= k) for N ~ Poisson(lambda); log-space pmf recurrence so large lambda does not underflow.
export function poissonTail(k: number, lambda: number): number {
  const n = Math.ceil(k);
  if (n <= 0) return 1;
  if (!(lambda > 0)) return 0;
  const logLambda = Math.log(lambda);
  let logp = -lambda;
  if (n <= lambda) {
    let below = Math.exp(logp);
    for (let i = 1; i < n; i++) {
      logp += logLambda - Math.log(i);
      below += Math.exp(logp);
    }
    return Math.min(1, Math.max(0, 1 - below));
  }
  for (let i = 1; i <= n; i++) logp += logLambda - Math.log(i);
  let tail = 0;
  for (let i = n; i < n + 100_000; i++) {
    const term = Math.exp(logp);
    tail += term;
    if (term <= tail * 1e-17) break;
    logp += logLambda - Math.log(i + 1);
  }
  return Math.min(1, tail);
}
