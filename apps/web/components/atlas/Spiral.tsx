import type { LiquidityStats } from "@slipway/core";
import { bp, num, seconds, sessionLabel, usd } from "../site/fmt";
import styles from "./atlas.module.css";
import {
  bandPath,
  bandPoint,
  GEOM,
  type Metric,
  metricColor,
  metricValue,
  outerRadius,
  tickPoint,
  WEEK_SPANS,
} from "./geometry";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SESSION_ARCS = [
  { a: 20, b: 28, name: "overnight", main: false },
  { a: 4, b: 9.5, name: "pre-market", main: false },
  { a: 9.5, b: 16, name: "regular session", main: true },
  { a: 16, b: 20, name: "after-hours", main: false },
];

export function formatMetric(v: number | null, m: Metric): string {
  if (v === null) return "not observed";
  return m === "depth" ? usd(v) : m === "spread" ? bp(v, 2) : seconds(v);
}

/**
 * One venue's trading week as a seven-turn spiral, each session span inked by the chosen metric.
 * Sessions with no recorded book are hatched: not observed, never interpolated.
 */
export function Spiral({
  stats,
  metric,
  id,
  detailed = false,
  label,
}: {
  /** atlas entries for this symbol and venue, keyed by session */
  stats: Partial<Record<string, LiquidityStats>>;
  metric: Metric;
  id: string;
  detailed?: boolean;
  label: string;
}) {
  const R = outerRadius();
  const pad = detailed ? 34 : 6;
  const vb = R + pad;
  const observed = WEEK_SPANS.filter((s) => metricValue(stats[s.s], metric) !== null).length;
  return (
    <svg
      className={styles.spiral}
      viewBox={`${-vb} ${-vb} ${vb * 2} ${vb * 2}`}
      role="img"
      aria-label={`${label}: ${observed ? "" : "no session observed yet. "}${[
        ...new Set(WEEK_SPANS.map((s) => s.s)),
      ]
        .map((s) => `${sessionLabel(s)} ${formatMetric(metricValue(stats[s], metric), metric)}`)
        .join("; ")}`}
    >
      <defs>
        <pattern
          id={`${id}-hatch`}
          width="3"
          height="3"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="3" style={{ stroke: "var(--hatch)" }} strokeWidth="0.8" />
        </pattern>
      </defs>
      {WEEK_SPANS.map((sp) => {
        const s = stats[sp.s];
        const v = metricValue(s, metric);
        const c = metricColor(v, metric);
        return (
          <path
            key={sp.a}
            d={bandPath(sp.a, sp.b)}
            className={c ? styles.cell : styles.cellNone}
            style={c ? { fill: c } : { fill: `url(#${id}-hatch)` }}
          >
            <title>
              {`${DAYS[Math.floor(sp.a / 24)]} ${sessionLabel(sp.s).toLowerCase()}: ${formatMetric(v, metric)}${
                s ? ` (${num(s.n)} snapshots)` : ""
              }`}
            </title>
          </path>
        );
      })}
      {/* hairline between turns so the coil reads as one ribbon */}
      <path
        d={(() => {
          const pts: string[] = [];
          for (let i = 0; i <= 7 * 48; i++) {
            const th = (i / 48) * 2 * Math.PI;
            const r = GEOM.r0 + (GEOM.pitch * th) / (2 * Math.PI) - (GEOM.pitch - GEOM.band) / 2;
            pts.push(`${(r * Math.sin(th)).toFixed(2)},${(-r * Math.cos(th)).toFixed(2)}`);
          }
          return `M${pts.join("L")}`;
        })()}
        fill="none"
        style={{ stroke: "var(--rule)" }}
        strokeWidth="0.4"
      />
      {detailed && (
        <g>
          {[0, 6, 12, 18].map((h) => {
            const [tx, ty] = tickPoint(h, GEOM.r0 - 12);
            return (
              <text key={h} x={tx} y={ty + 2.5} textAnchor="middle" className={styles.spiralTick}>
                {String(h).padStart(2, "0")}
              </text>
            );
          })}
          {[4, 9.5, 16, 20].map((h) => {
            const [x1, y1] = tickPoint(h, GEOM.r0 - 4);
            const [x2, y2] = tickPoint(h, R + 6);
            return (
              <line
                key={h}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                style={{ stroke: "var(--text)" }}
                strokeWidth="0.5"
                strokeDasharray="1.5 2"
                opacity="0.5"
              />
            );
          })}
          {SESSION_ARCS.map((a, k) => {
            const ra = R + 9;
            const rl = R + 19;
            const t0 = (a.a / 24) * 2 * Math.PI + 0.02;
            const t1 = (a.b / 24) * 2 * Math.PI - 0.02;
            const [x0, y0] = tickPoint(a.a + 0.1, ra);
            const [x1, y1] = tickPoint(a.b - 0.1, ra);
            const mid = (t0 + t1) / 2;
            const bottom = Math.cos(mid) < 0;
            const r = bottom ? rl + 5 : rl;
            const [u0, v0] = tickPoint(bottom ? a.b - 0.1 : a.a + 0.1, r);
            const [u1, v1] = tickPoint(bottom ? a.a + 0.1 : a.b - 0.1, r);
            const large = t1 - t0 > Math.PI ? 1 : 0;
            return (
              <g key={a.name}>
                <path
                  d={`M${x0},${y0}A${ra},${ra} 0 ${large} 1 ${x1},${y1}`}
                  fill="none"
                  style={{ stroke: "var(--text)" }}
                  strokeWidth={a.main ? 2.2 : 0.8}
                  opacity={a.main ? 0.9 : 0.55}
                />
                <path
                  id={`${id}-arc${k}`}
                  d={`M${u0},${v0}A${r},${r} 0 0 ${bottom ? 0 : 1} ${u1},${v1}`}
                  fill="none"
                />
                <text className={styles.spiralSession}>
                  <textPath href={`#${id}-arc${k}`} startOffset="50%" textAnchor="middle">
                    {a.name}
                  </textPath>
                </text>
              </g>
            );
          })}
          {DAYS.map((d, i) => {
            const [x, y] = bandPoint(i * 24 + 0.6);
            return (
              <text key={d} x={x + 2} y={y + 2.5} className={styles.spiralDay}>
                {d}
              </text>
            );
          })}
        </g>
      )}
    </svg>
  );
}
