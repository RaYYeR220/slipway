"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useId, useMemo, useState } from "react";
import { usd, usdTick } from "../site/fmt";
import { log10Scale } from "../site/scale";
import ui from "../site/ui.module.css";
import { tipStyle, useWidth } from "../site/useChart";
import styles from "./landing.module.css";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const START = 20; // the strip opens Sunday 20:00 New York, when the trading week's overnight session begins
const pos = (i: number) => (i - START + 168) % 168;
const idx = (p: number) => (p + START) % 168;
const hourLabel = (i: number) => {
  const d = DAYS[Math.floor(i / 24)] ?? "";
  const h = i % 24;
  return `${d} ${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00 ET`;
};

function nyHourOfWeek(): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const o: Record<string, string> = {};
  for (const x of p) o[x.type] = x.value;
  return DAYS.indexOf(o.weekday ?? "Sun") * 24 + (Number(o.hour) % 24);
}

export interface WeekStripProps {
  rtoken: (number | null)[];
  perp: (number | null)[] | null;
  weeks: number[];
  rtokenName: string;
  perpName: string;
}

export function WeekStrip({ rtoken, perp, weeks, rtokenName, perpName }: WeekStripProps) {
  const [box, width] = useWidth<HTMLDivElement>(1100);
  const [active, setActive] = useState<number | null>(null);
  const hatchId = `wk-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(nyHourOfWeek()), []);

  const narrow = width < 640;
  const H = narrow ? 250 : 330;
  const m = { l: narrow ? 40 : 52, r: 8, t: 34, b: 30 };
  const iw = Math.max(10, width - m.l - m.r);
  const bw = iw / 168;
  const ly = log10Scale([100, 1e10], [H - m.b, m.t]);
  // rounded: Math.log10 may differ in the last bit between server and browser, which breaks hydration
  const y = (v: number) => Math.round(ly(v) * 100) / 100;
  const x = (p: number) => m.l + p * bw;
  const barW = Math.max(0.8, bw - (bw > 5 ? 2 : 0.6));

  const extremes = useMemo(() => {
    let lo: number | null = null;
    let hi: number | null = null;
    rtoken.forEach((v, i) => {
      if (typeof v !== "number") return;
      const d = Math.floor(i / 24);
      const h = i % 24;
      const weekend = (d === 5 && h >= 20) || d === 6 || (d === 0 && h < 20);
      if (weekend && (lo === null || v < (rtoken[lo] as number))) lo = i;
      if (!weekend && (hi === null || v > (rtoken[hi] as number))) hi = i;
    });
    return { lo, hi } as { lo: number | null; hi: number | null };
  }, [rtoken]);

  let perpPath = "";
  if (perp) {
    let pen = false;
    for (let p = 0; p < 168; p++) {
      const v = perp[idx(p)];
      if (typeof v !== "number") {
        pen = false;
        continue;
      }
      perpPath += `${pen ? "L" : "M"}${(x(p) + bw / 2).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
  }

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = Math.floor((e.clientX - r.left - m.l) / bw);
    setActive(p >= 0 && p < 168 ? idx(p) : null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? now ?? 0;
    if (e.key === "ArrowRight") setActive(idx((pos(cur) + 1) % 168));
    else if (e.key === "ArrowLeft") setActive(idx((pos(cur) + 167) % 168));
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const regular = [1, 2, 3, 4, 5].map((d) => ({ a: pos(d * 24 + 9) + 0.5, b: pos(d * 24 + 16) }));
  const weekendA = pos(5 * 24 + 20);
  const tickVals = [1e3, 1e5, 1e7, 1e9];
  const ap = active === null ? null : pos(active);
  const tipX = ap === null ? 0 : x(ap) + bw / 2;
  const av = active === null ? null : rtoken[active];
  const tipY = ap === null ? 0 : typeof av === "number" ? y(av) : H / 2;

  return (
    <div className={ui.chart} ref={box}>
      <div
        role="slider"
        className={styles.weekSlider}
        aria-label={`Hour of the New York week: median USDT traded per hour on ${rtokenName}${perp ? ` and ${perpName}` : ""}. Arrow keys step through hours.`}
        aria-valuemin={0}
        aria-valuemax={167}
        aria-valuenow={active ?? now ?? 0}
        aria-valuetext={(() => {
          const i = active ?? now ?? 0;
          return `${hourLabel(i)}: ${rtokenName} ${usd(rtoken[i])}${perp ? `, ${perpName} ${usd(perp[i])}` : ""}`;
        })()}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          aria-hidden="true"
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          className={styles.weekSvg}
        >
          <defs>
            <pattern
              id={hatchId}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--hatch)" }} strokeWidth="1" />
            </pattern>
          </defs>
          {/* context: the weekend is land, the regular sessions are the deep channel */}
          <rect
            x={x(weekendA)}
            y={m.t}
            width={x(168) - x(weekendA)}
            height={H - m.t - m.b}
            fill={`url(#${hatchId})`}
            opacity="0.7"
          />
          {regular.map((r) => (
            <rect
              key={r.a}
              x={x(r.a)}
              y={m.t}
              width={x(r.b) - x(r.a)}
              height={H - m.t - m.b}
              style={{ fill: "var(--grid)" }}
              opacity="0.75"
            />
          ))}
          {!narrow && (
            <text className={ui.annot} x={x(weekendA) + 6} y={m.t - 10}>
              weekend
            </text>
          )}
          {!narrow && (
            <text className={ui.annot} x={x(regular[0]?.a ?? 0)} y={m.t - 10}>
              New York regular session
            </text>
          )}
          {tickVals.map((t) => (
            <g key={t}>
              <line className={ui.gridLine} x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
              <text className={ui.axisText} x={m.l - 8} y={y(t) + 3.5} textAnchor="end">
                {usdTick(t)}
              </text>
            </g>
          ))}
          <line className={ui.axisLine} x1={m.l} x2={width - m.r} y1={H - m.b} y2={H - m.b} />
          {[1, 2, 3, 4, 5, 6, 7].map((d) => {
            const p = pos((d % 7) * 24) || 168;
            return (
              <g key={d}>
                <line className={ui.axisLine} x1={x(p)} x2={x(p)} y1={H - m.b} y2={H - m.b + 5} />
                {p < 166 && (
                  <text className={ui.axisText} x={x(p) + 4} y={H - m.b + 16}>
                    {DAYS[d % 7]}
                  </text>
                )}
              </g>
            );
          })}
          {rtoken.map((v, i) => {
            if (typeof v !== "number") return null;
            // the index is the hour of the week: a stable key
            const p = pos(i);
            const top = y(v);
            const base = H - m.b;
            const r = Math.min(2, barW / 2);
            const bx = x(p) + (bw - barW) / 2;
            return (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: index = hour of the week, fixed
                key={i}
                d={`M${bx},${base}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + barW - r}Q${bx + barW},${top} ${bx + barW},${top + r}V${base}Z`}
                style={{ fill: "var(--venue-rtoken)" }}
                opacity={active === null || active === i ? 1 : 0.55}
              />
            );
          })}
          {perpPath && (
            <path
              d={perpPath}
              fill="none"
              style={{ stroke: "var(--venue-perp)" }}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {[extremes.lo, extremes.hi].map((i, k) => {
            if (i === null) return null;
            const v = rtoken[i] as number;
            const p = pos(i);
            const tx = x(p) + bw / 2;
            const anchor = k === 0 ? "end" : tx < width / 2 ? "start" : "middle";
            return (
              <g key={k === 0 ? "lo" : "hi"}>
                <circle
                  cx={tx}
                  cy={y(v)}
                  r="3.5"
                  style={{ fill: "var(--text)", stroke: "var(--bg)" }}
                  strokeWidth="2"
                />
                <text className={ui.dataLabel} x={k === 0 ? tx - 6 : tx} y={y(v) - 10} textAnchor={anchor}>
                  {usd(v)} · {hourLabel(i).split("–")[0]}
                </text>
              </g>
            );
          })}
          {now !== null && (
            <g>
              <line
                x1={x(pos(now)) + bw / 2}
                x2={x(pos(now)) + bw / 2}
                y1={m.t - 20}
                y2={H - m.b}
                style={{ stroke: "var(--live)" }}
                strokeWidth="1.5"
              />
              <text x={x(pos(now)) + bw / 2 + 5} y={m.t - 10} className={ui.liveLabel}>
                now
              </text>
            </g>
          )}
          {ap !== null && (
            <rect
              x={x(ap) - 1}
              y={m.t}
              width={bw + 2}
              height={H - m.t - m.b}
              fill="none"
              style={{ stroke: "var(--text)" }}
              strokeWidth="1"
              opacity="0.5"
            />
          )}
        </svg>
      </div>
      {active !== null && (
        <div className={ui.tip} style={tipStyle({ x: tipX, y: tipY }, width)} aria-hidden="true">
          <span>{hourLabel(active)}</span>
          <span className={ui.tipRow}>
            <i className={ui.key} style={{ background: "var(--venue-rtoken)" }} />
            <strong>{usd(rtoken[active])}</strong>
          </span>
          <span>{rtokenName}</span>
          {perp && (
            <>
              <span className={ui.tipRow}>
                <i className={ui.lineKey} style={{ background: "var(--venue-perp)" }} />
                <strong>{usd(perp[active])}</strong>
              </span>
              <span>{perpName}</span>
            </>
          )}
          <span>median of {weeks[active] ?? 0} weeks</span>
        </div>
      )}
    </div>
  );
}
