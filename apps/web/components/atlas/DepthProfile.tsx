"use client";

import { type PointerEvent, useState } from "react";
import { usd, usdTick } from "../site/fmt";
import { linear, ticks } from "../site/scale";
import ui from "../site/ui.module.css";
import { tipStyle, useWidth } from "../site/useChart";
import styles from "./atlas.module.css";

/** Cumulative notional from mid outward: [distance in bp (negative = bids), cumulative USDT]. */
export interface Ladder {
  venue: "rtoken" | "perp";
  name: string;
  bids: [number, number][];
  asks: [number, number][];
}

const LIMIT = 50;
const r2 = (n: number) => Math.round(n * 100) / 100;

function at(side: [number, number][], d: number): number {
  // cumulative notional available within |d| bp on this side (step function)
  let v = 0;
  for (const [x, c] of side) {
    if (Math.abs(x) <= Math.abs(d)) v = c;
    else break;
  }
  return v;
}

export function DepthProfile({ ladders }: { ladders: Ladder[] }) {
  const [box, width] = useWidth<HTMLDivElement>(1000);
  const [hover, setHover] = useState<number | null>(null);
  const narrow = width < 640;
  const H = narrow ? 260 : 320;
  const m = { l: narrow ? 48 : 60, r: 12, t: 16, b: 34 };
  const ymax = Math.max(1, ...ladders.flatMap((l) => [...l.bids, ...l.asks].map((p) => p[1]))) * 1.06;
  const x = linear([-LIMIT, LIMIT], [m.l, width - m.r]);
  const y = linear([0, ymax], [H - m.b, m.t]);
  const yt = ticks(0, ymax, 4);
  const color = (v: string) => (v === "rtoken" ? "var(--venue-rtoken)" : "var(--venue-perp)");

  const step = (side: [number, number][], sign: 1 | -1) => {
    let d = `M${r2(x(0))},${r2(y(0))}`;
    let prev = 0;
    for (const [dist, c] of side) {
      if (Math.abs(dist) > LIMIT) break;
      d += `L${r2(x(dist))},${r2(y(prev))}L${r2(x(dist))},${r2(y(c))}`;
      prev = c;
    }
    d += `L${r2(x(sign * LIMIT))},${r2(y(prev))}`;
    return d;
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const d = ((e.clientX - b.left - m.l) / (width - m.l - m.r)) * 2 * LIMIT - LIMIT;
    setHover(d >= -LIMIT && d <= LIMIT ? Math.round(d * 2) / 2 : null);
  };

  return (
    <div className={ui.chart} ref={box}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={`Cumulative order-book notional out to ${LIMIT} bp each side of mid: ${ladders
          .map(
            (l) =>
              `${l.name} ${usd(at(l.asks, 25))} of asks and ${usd(at(l.bids, -25))} of bids within 25 bp`,
          )
          .join("; ")}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className={styles.depthSvg}
      >
        {yt.map((t) => (
          <g key={t}>
            <line className={ui.gridLine} x1={m.l} x2={width - m.r} y1={r2(y(t))} y2={r2(y(t))} />
            <text className={ui.axisText} x={m.l - 8} y={r2(y(t)) + 3.5} textAnchor="end">
              {usdTick(t)}
            </text>
          </g>
        ))}
        {[-50, -25, -10, 0, 10, 25, 50].map((t) => (
          <g key={t}>
            <line
              x1={r2(x(t))}
              x2={r2(x(t))}
              y1={m.t}
              y2={H - m.b}
              style={{ stroke: t === 0 ? "var(--muted)" : "var(--grid)" }}
              strokeWidth="1"
            />
            <text className={ui.axisText} x={r2(x(t))} y={H - m.b + 16} textAnchor="middle">
              {t === 0 ? "mid" : t > 0 ? `+${t}` : `−${-t}`}
            </text>
          </g>
        ))}
        <text className={ui.annot} x={m.l + 8} y={m.t + 12}>
          bids, to sell into
        </text>
        <text className={ui.annot} x={width - m.r - 8} y={m.t + 12} textAnchor="end">
          asks, to buy from
        </text>
        {ladders.map((l) => (
          <g key={l.venue}>
            <path
              d={`${step(l.bids, -1)}L${r2(x(-LIMIT))},${r2(y(0))}Z`}
              style={{ fill: color(l.venue) }}
              opacity="0.1"
            />
            <path
              d={`${step(l.asks, 1)}L${r2(x(LIMIT))},${r2(y(0))}Z`}
              style={{ fill: color(l.venue) }}
              opacity="0.1"
            />
            <path
              d={step(l.bids, -1)}
              fill="none"
              style={{ stroke: color(l.venue) }}
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path
              d={step(l.asks, 1)}
              fill="none"
              style={{ stroke: color(l.venue) }}
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </g>
        ))}
        <line className={ui.axisLine} x1={m.l} x2={width - m.r} y1={H - m.b} y2={H - m.b} />
        {hover !== null && (
          <line
            x1={r2(x(hover))}
            x2={r2(x(hover))}
            y1={m.t}
            y2={H - m.b}
            style={{ stroke: "var(--text)" }}
            strokeWidth="1"
            opacity="0.6"
          />
        )}
      </svg>
      {hover !== null && (
        <div className={ui.tip} style={tipStyle({ x: x(hover), y: m.t + 20 }, width, 210)} aria-hidden="true">
          <span>
            within {Math.abs(hover)} bp {hover < 0 ? "below" : "above"} mid
          </span>
          {ladders.map((l) => (
            <span key={l.venue} className={ui.tipRow}>
              <i className={ui.lineKey} style={{ background: color(l.venue) }} />
              <strong>{usd(at(hover < 0 ? l.bids : l.asks, hover))}</strong>
              <span>{l.name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
