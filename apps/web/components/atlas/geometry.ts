// Geometry and colour mapping for the weekly spiral: seven turns, one per day, Sunday innermost; midnight New York
// at the top, hours running clockwise. Pure functions, safe on the server.
import type { LiquidityStats } from "@slipway/core";

export type Metric = "depth" | "spread" | "halflife";
export const METRICS: { id: Metric; label: string; long: string }[] = [
  { id: "depth", label: "Depth ±25 bp", long: "Median notional per side within 25 bp of mid" },
  { id: "spread", label: "Spread", long: "Median quoted spread" },
  {
    id: "halflife",
    label: "Refill half-life",
    long: "Median time for the book to recover half of a depletion",
  },
];
export const metricOf = (m: string | undefined): Metric =>
  m === "spread" || m === "halflife" || m === "depth" ? m : "depth";

export const SESSIONS = ["pre_market", "regular", "after_hours", "overnight", "weekend"] as const;
export type SessionId = (typeof SESSIONS)[number];

/** The week as session spans in hours from Sunday 00:00 New York (typical week, no holidays). */
export const WEEK_SPANS: { a: number; b: number; s: SessionId }[] = (() => {
  const out: { a: number; b: number; s: SessionId }[] = [
    { a: 0, b: 20, s: "weekend" },
    { a: 20, b: 24, s: "overnight" },
  ];
  for (let d = 1; d <= 5; d++) {
    const o = d * 24;
    out.push(
      { a: o, b: o + 4, s: "overnight" },
      { a: o + 4, b: o + 9.5, s: "pre_market" },
      { a: o + 9.5, b: o + 16, s: "regular" },
      { a: o + 16, b: o + 20, s: "after_hours" },
      { a: o + 20, b: o + 24, s: d === 5 ? "weekend" : "overnight" },
    );
  }
  out.push({ a: 144, b: 168, s: "weekend" });
  return out;
})();

export interface SpiralGeom {
  r0: number;
  pitch: number;
  band: number;
}
export const GEOM: SpiralGeom = { r0: 34, pitch: 15, band: 12.5 };
export const outerRadius = (g: SpiralGeom = GEOM) => g.r0 + 7 * g.pitch + g.band;

const r2 = (n: number) => Math.round(n * 100) / 100;
const polar = (r: number, th: number): [number, number] => [r2(r * Math.sin(th)), r2(-r * Math.cos(th))];

/** Closed path of the spiral band between hour-of-week a and b. */
export function bandPath(a: number, b: number, g: SpiralGeom = GEOM): string {
  const th0 = (a / 24) * 2 * Math.PI;
  const th1 = (b / 24) * 2 * Math.PI;
  const R = (th: number) => g.r0 + (g.pitch * th) / (2 * Math.PI);
  const n = Math.max(2, Math.ceil((b - a) * 2));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const th = th0 + ((th1 - th0) * i) / n;
    pts.push(polar(R(th), th));
  }
  for (let i = n; i >= 0; i--) {
    const th = th0 + ((th1 - th0) * i) / n;
    pts.push(polar(R(th) + g.band, th));
  }
  return `M${pts.map((p) => `${p[0]},${p[1]}`).join("L")}Z`;
}

/** Point at the middle of the band for hour-of-week h (for labels). */
export function bandPoint(h: number, g: SpiralGeom = GEOM): [number, number] {
  const th = (h / 24) * 2 * Math.PI;
  return polar(g.r0 + (g.pitch * th) / (2 * Math.PI) + g.band / 2, th);
}

export function tickPoint(hourOfDay: number, r: number): [number, number] {
  return polar(r, (hourOfDay / 24) * 2 * Math.PI);
}

/* ---------- metric values and the colour scale ---------- */

export function metricValue(s: LiquidityStats | undefined, m: Metric): number | null {
  if (!s) return null;
  const v =
    m === "depth" ? s.depthUsd?.b25?.p50 : m === "spread" ? s.spreadBps?.p50 : s.resilience?.halfLifeSec;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Log-scale domains, fixed so plates are comparable across symbols and over time. */
export const DOMAIN: Record<Metric, [number, number]> = {
  depth: [1e4, 1e7],
  spread: [0.2, 50],
  halflife: [0.5, 120],
};

export const RAMP_STOPS: Record<Metric, { v: number; label: string }[]> = {
  depth: [
    { v: 1e4, label: "$10k" },
    { v: 1e5, label: "$100k" },
    { v: 1e6, label: "$1M" },
    { v: 1e7, label: "$10M" },
  ],
  spread: [
    { v: 0.2, label: "0.2" },
    { v: 1, label: "1" },
    { v: 5, label: "5" },
    { v: 50, label: "50 bp" },
  ],
  halflife: [
    { v: 0.5, label: "0.5 s" },
    { v: 5, label: "5 s" },
    { v: 30, label: "30 s" },
    { v: 120, label: "2 min" },
  ],
};

/** Position 0..1 on the metric's log domain. */
export function metricT(v: number, m: Metric): number {
  const [lo, hi] = DOMAIN[m];
  const t = (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return Math.max(0, Math.min(1, t));
}

/** CSS colour for a value: depth on the tempo ramp, spread and half-life on the solar (cost) ramp. */
export function metricColor(v: number | null, m: Metric): string | null {
  if (v === null) return null;
  const t = metricT(v, m);
  if (m === "depth") return `var(--depth-${Math.round(t * 8)})`;
  return `var(--cost-${Math.round(t * 7)})`;
}

export function rampGradient(m: Metric): string {
  const n = m === "depth" ? 9 : 8;
  const name = m === "depth" ? "depth" : "cost";
  return `linear-gradient(90deg, ${Array.from({ length: n }, (_, i) => `var(--${name}-${i})`).join(", ")})`;
}
