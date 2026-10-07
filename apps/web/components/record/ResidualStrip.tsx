"use client";

import { type PointerEvent, useMemo, useState } from "react";
import { bp, num, nyTime, signedBp, venueLabel } from "../site/fmt";
import { extent, linear, ticks } from "../site/scale";
import ui from "../site/ui.module.css";
import { tipStyle, useWidth } from "../site/useChart";
import type { ScatterPoint } from "./ForecastScatter";
import styles from "./record.module.css";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * NOAA-style "predicted vs verified" residual strip: tape minus forecast for each graded order over time,
 * with the residual distribution as a histogram on the same vertical axis.
 */
export function ResidualStrip({ points }: { points: ScatterPoint[] }) {
  const [box, width] = useWidth<HTMLDivElement>(1000);
  const [hot, setHot] = useState<number | null>(null);
  const narrow = width < 640;
  const H = narrow ? 230 : 260;
  const histW = narrow ? 70 : 150;
  const m = { l: narrow ? 40 : 56, r: 12, t: 12, b: 30 };
  const plotR = width - m.r - histW - 16;
  const res = useMemo(() => points.map((p) => p.r - p.f), [points]);
  const [t0, t1] = useMemo(() => extent(points.map((p) => p.a)), [points]);
  const ydom = useMemo(() => {
    const [lo, hi] = extent(res);
    const a = Math.max(Math.abs(lo), Math.abs(hi), 1);
    return [-Math.ceil(a * 1.05), Math.ceil(a * 1.05)] as [number, number];
  }, [res]);
  const x = linear([t0, t1 === t0 ? t0 + 1 : t1], [m.l, plotR]);
  const y = linear(ydom, [H - m.b, m.t]);
  const yt = ticks(ydom[0], ydom[1], 5);

  const bins = useMemo(() => {
    const span = ydom[1] - ydom[0];
    const step = span > 60 ? 4 : span > 30 ? 2 : 1;
    const out = new Map<number, number>();
    for (const r of res) {
      const k = Math.floor(r / step) * step;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return { step, rows: [...out.entries()].sort((a, b) => a[0] - b[0]) };
  }, [res, ydom]);
  const cmax = Math.max(1, ...bins.rows.map((b) => b[1]));
  const hx = linear([0, cmax], [plotR + 16, width - m.r]);

  const hours = useMemo(() => {
    const out: number[] = [];
    const step = 3600_000 * (t1 - t0 > 86_400_000 * 2 ? 12 : t1 - t0 > 86_400_000 ? 6 : 2);
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
    return out;
  }, [t0, t1]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    let best = -1;
    let bd = 20 * 20;
    points.forEach((p, i) => {
      const dx = x(p.a) - px;
      const dy = y(res[i] as number) - py;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHot(best >= 0 ? best : null);
  };
  const hp = hot === null ? null : points[hot];
  const within1 = res.filter((r) => Math.abs(r) <= 1).length;

  return (
    <div className={ui.chart} ref={box}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={`Tape minus forecast for ${points.length} graded forecasts over time; ${within1} within one basis point.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHot(null)}
        className={styles.scatterSvg}
      >
        {yt.map((t) => (
          <g key={t}>
            <line className={ui.gridLine} x1={m.l} x2={width - m.r} y1={r2(y(t))} y2={r2(y(t))} />
            <text className={ui.axisText} x={m.l - 8} y={r2(y(t)) + 3.5} textAnchor="end">
              {t > 0 ? `+${t}` : t < 0 ? `−${-t}` : "0"}
            </text>
          </g>
        ))}
        <line
          x1={m.l}
          x2={width - m.r}
          y1={r2(y(0))}
          y2={r2(y(0))}
          style={{ stroke: "var(--muted)" }}
          strokeWidth="1"
        />
        {hours.map((t) => (
          <g key={t}>
            <line className={ui.axisLine} x1={r2(x(t))} x2={r2(x(t))} y1={H - m.b} y2={H - m.b + 4} />
            <text className={ui.axisText} x={r2(x(t))} y={H - m.b + 16} textAnchor="middle">
              {nyTime(t).split(" ").slice(0, 1).join("")} {nyTime(t).split(" ")[3]}
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: points never reorder
            key={i}
            cx={r2(x(p.a))}
            cy={r2(y(res[i] as number))}
            r={narrow ? 2 : 2.4}
            style={{ fill: p.v === "rtoken" ? "var(--venue-rtoken)" : "var(--venue-perp)" }}
            opacity="0.75"
          />
        ))}
        {bins.rows.map(([k, c]) => {
          const y0 = y(k + bins.step);
          const y1 = y(k);
          const h = Math.max(1, y1 - y0 - 1);
          return (
            <rect
              key={k}
              x={r2(hx(0))}
              y={r2(y0 + 0.5)}
              width={r2(Math.max(1, hx(c) - hx(0)))}
              height={r2(h)}
              style={{ fill: "var(--muted)" }}
              opacity="0.85"
            >
              <title>{`${k} to ${k + bins.step} bp: ${c} forecasts`}</title>
            </rect>
          );
        })}
        <line className={ui.axisLine} x1={r2(hx(0))} x2={r2(hx(0))} y1={m.t} y2={H - m.b} />
        <text className={ui.axisText} x={width - m.r} y={H - m.b + 16} textAnchor="end">
          {num(cmax)} max
        </text>
        {hp && (
          <circle
            cx={r2(x(hp.a))}
            cy={r2(y(hp.r - hp.f))}
            r={5}
            style={{
              fill: hp.v === "rtoken" ? "var(--venue-rtoken)" : "var(--venue-perp)",
              stroke: "var(--bg)",
            }}
            strokeWidth="2"
          />
        )}
      </svg>
      {hp && (
        <div
          className={ui.tip}
          style={tipStyle({ x: x(hp.a), y: y(hp.r - hp.f) }, width, 210)}
          aria-hidden="true"
        >
          <span>
            {hp.s} · {venueLabel(hp.v)} · {hp.fam}
          </span>
          <strong>{signedBp(hp.r - hp.f, 2)}</strong>
          <span>
            tape {bp(hp.r, 2)} vs forecast {bp(hp.f, 2)}
          </span>
          <span>{nyTime(hp.a)}</span>
        </div>
      )}
    </div>
  );
}
