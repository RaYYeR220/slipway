"use client";

import { type PointerEvent, useMemo, useState } from "react";
import { bp, nyTime, sessionLabel, signedBp, venueLabel } from "../site/fmt";
import { extent, linear, ticks } from "../site/scale";
import ui from "../site/ui.module.css";
import { tipStyle, useWidth } from "../site/useChart";
import styles from "./record.module.css";

/** One graded order-level forecast: time, forecast p50/p10/p90, realized, venue and labels. */
export interface ScatterPoint {
  a: number;
  f: number;
  r: number;
  lo: number | null;
  hi: number | null;
  v: string;
  fam: string;
  h: string;
  s: string;
  se: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function Mark({
  x,
  y,
  venue,
  r = 4,
  active = false,
}: {
  x: number;
  y: number;
  venue: string;
  r?: number;
  active?: boolean;
}) {
  const fill = venue === "rtoken" ? "var(--venue-rtoken)" : "var(--venue-perp)";
  const style = { fill, stroke: "var(--bg)" };
  const sw = active ? 2.5 : 1.5;
  // circles for rToken, squares for perp: identity never rides on colour alone
  return venue === "rtoken" ? (
    <circle cx={x} cy={y} r={r} style={style} strokeWidth={sw} />
  ) : (
    <rect
      x={r2(x - r * 0.9)}
      y={r2(y - r * 0.9)}
      width={r2(r * 1.8)}
      height={r2(r * 1.8)}
      style={style}
      strokeWidth={sw}
    />
  );
}

/** Forecast (x) against what the tape charged (y). On the diagonal = perfect forecast. */
export function ForecastScatter({ points, label }: { points: ScatterPoint[]; label: string }) {
  const [box, width] = useWidth<HTMLDivElement>(1000);
  const [hot, setHot] = useState<number | null>(null);
  const narrow = width < 640;
  const H = narrow ? 340 : Math.min(560, Math.max(380, width * 0.5));
  const m = { l: narrow ? 40 : 56, r: 16, t: 16, b: 44 };
  const dom = useMemo(() => {
    const [lo, hi] = extent(points.flatMap((p) => [p.f, p.r]));
    const pad = (hi - lo) * 0.05 || 1;
    return [Math.floor(lo - pad), Math.ceil(hi + pad)] as [number, number];
  }, [points]);
  const x = linear(dom, [m.l, width - m.r]);
  const y = linear(dom, [H - m.b, m.t]);
  const tv = ticks(dom[0], dom[1], narrow ? 4 : 7);
  const lab = dom[0] + (dom[1] - dom[0]) * (narrow ? 0.62 : 0.8);
  const clamp = (v: number) => Math.max(dom[0], Math.min(dom[1], v));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    let best = -1;
    let bd = 24 * 24;
    points.forEach((p, i) => {
      const dx = x(p.f) - px;
      const dy = y(p.r) - py;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHot(best >= 0 ? best : null);
  };
  const hp = hot === null ? null : points[hot];

  return (
    <div className={ui.chart} ref={box}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={`${points.length} graded forecasts: forecast cost against realized cost (${label}). Points on the diagonal were forecast exactly.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHot(null)}
        className={styles.scatterSvg}
      >
        {tv.map((t) => (
          <g key={t}>
            <line className={ui.gridLine} x1={m.l} x2={width - m.r} y1={r2(y(t))} y2={r2(y(t))} />
            <line className={ui.gridLine} x1={r2(x(t))} x2={r2(x(t))} y1={m.t} y2={H - m.b} />
            <text className={ui.axisText} x={m.l - 8} y={r2(y(t)) + 3.5} textAnchor="end">
              {t}
            </text>
            <text className={ui.axisText} x={r2(x(t))} y={H - m.b + 16} textAnchor="middle">
              {t}
            </text>
          </g>
        ))}
        <line className={ui.axisLine} x1={m.l} x2={width - m.r} y1={H - m.b} y2={H - m.b} />
        <line className={ui.axisLine} x1={m.l} x2={m.l} y1={m.t} y2={H - m.b} />
        <line
          x1={r2(x(dom[0]))}
          y1={r2(y(dom[0]))}
          x2={r2(x(dom[1]))}
          y2={r2(y(dom[1]))}
          style={{ stroke: "var(--muted)" }}
          strokeWidth="1"
        />
        <text className={ui.annot} x={r2(x(lab)) + 8} y={r2(y(lab)) + 16}>
          forecast = tape
        </text>
        <text className={ui.annot} x={r2(x(dom[1])) - 8} y={H - m.b - 10} textAnchor="end">
          tape cheaper than forecast
        </text>
        <text className={ui.annot} x={m.l + 10} y={m.t + 14}>
          tape dearer than forecast
        </text>
        {points.map((p, i) =>
          p.lo !== null && p.hi !== null && p.hi - p.lo > 0.05 ? (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: points never reorder
              key={`b${i}`}
              x1={r2(x(clamp(p.lo)))}
              x2={r2(x(clamp(p.hi)))}
              y1={r2(y(p.r))}
              y2={r2(y(p.r))}
              style={{ stroke: p.v === "rtoken" ? "var(--venue-rtoken)" : "var(--venue-perp)" }}
              strokeWidth="1"
              opacity="0.1"
            />
          ) : null,
        )}
        {points.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: points never reorder
          <Mark key={i} x={r2(x(p.f))} y={r2(y(p.r))} venue={p.v} r={narrow ? 3 : 3.6} />
        ))}
        {hp && (
          <g>
            {hp.lo !== null && hp.hi !== null && (
              <line
                x1={r2(x(clamp(hp.lo)))}
                x2={r2(x(clamp(hp.hi)))}
                y1={r2(y(hp.r))}
                y2={r2(y(hp.r))}
                style={{ stroke: "var(--text)" }}
                strokeWidth="2"
              />
            )}
            <Mark x={r2(x(hp.f))} y={r2(y(hp.r))} venue={hp.v} r={6} active />
          </g>
        )}
        <text className={ui.axisLabel} x={width - m.r} y={H - 6} textAnchor="end">
          Forecast cost (p50), bp
        </text>
        <text
          className={ui.axisLabel}
          x={12}
          y={m.t + 2}
          transform={`rotate(-90 12 ${m.t + 2})`}
          textAnchor="end"
        >
          Realized cost on the tape, bp
        </text>
      </svg>
      {hp && (
        <div className={ui.tip} style={tipStyle({ x: x(hp.f), y: y(hp.r) }, width, 220)} aria-hidden="true">
          <span>
            {hp.s} · {venueLabel(hp.v)} · {hp.fam}
          </span>
          <strong>{bp(hp.r, 2)} realized</strong>
          <span>
            forecast {bp(hp.f, 2)}
            {hp.lo !== null && hp.hi !== null && hp.hi - hp.lo > 0.05
              ? ` (p10 ${bp(hp.lo)}, p90 ${bp(hp.hi)})`
              : ""}
          </span>
          <span>tape minus forecast {signedBp(hp.r - hp.f, 2)}</span>
          <span>
            {sessionLabel(hp.se)} · {hp.h} · {nyTime(hp.a)}
          </span>
        </div>
      )}
    </div>
  );
}
