"use client";
// Cost/risk frontier of every priced candidate: expected cost (y) against its standard deviation (x, square-root
// scale so near-certain plans and session-gap gambles both stay readable). The curve is the planner's iso-score
// line through the chosen plan — score = expected + λ·sd — so every point under it would have scored better.
import { useMemo, useState } from "react";
import { bps, FAMILY_ORDER, familyName, isBaselineId, num } from "@/lib/desk/format";
import type { OptionsData } from "@/lib/desk/types";
import s from "./charts.module.css";
import { useWidth } from "./hooks";
import { familyColor } from "./ramps";
import { niceTicks } from "./scale";

type Point = OptionsData["frontier"][number];

interface Props {
  points: Point[];
  lambda: number;
  chosenId: string | null;
  baselineId: string | null;
  light: boolean;
  height?: number;
}

const M = { l: 46, r: 14, t: 14, b: 36 };
const SQRT_TICKS = [0, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

export function Frontier({ points, lambda, chosenId, baselineId, light, height = 280 }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(260, width);
  const H = height;
  const [hover, setHover] = useState<Point | null>(null);

  const g = useMemo(() => {
    const sdMax = Math.max(1, ...points.map((p) => p.sdBps)) * 1.04;
    const es = points.map((p) => p.expectedBps);
    let eLo = Math.min(...es);
    let eHi = Math.max(...es);
    const pad = Math.max(0.4, (eHi - eLo) * 0.1);
    eLo -= pad;
    eHi += pad;
    const sx = (sd: number) => M.l + Math.sqrt(Math.max(0, sd) / sdMax) * (W - M.l - M.r);
    const sy = (e: number) => M.t + (1 - (e - eLo) / (eHi - eLo)) * (H - M.t - M.b);
    const xt = SQRT_TICKS.filter((t) => t <= sdMax);
    // thin the ticks so labels never touch
    const xTicks: number[] = [];
    for (const t of xt)
      if (!xTicks.length || sx(t) - sx(xTicks[xTicks.length - 1] as number) > 34) xTicks.push(t);
    const yTicks = niceTicks(eLo, eHi, 4);
    const chosen = points.find((p) => p.id === chosenId) ?? null;
    let iso = "";
    if (chosen) {
      const pts: string[] = [];
      for (let i = 0; i <= 80; i++) {
        const sd = (sdMax * i * i) / 6400;
        const e = chosen.score - lambda * sd;
        if (e < eLo || e > eHi) continue;
        pts.push(`${sx(sd).toFixed(1)},${sy(e).toFixed(1)}`);
      }
      iso = pts.length > 1 ? `M${pts.join("L")}` : "";
    }
    return { sx, sy, xTicks, yTicks, chosen, iso };
  }, [points, W, H, chosenId, lambda]);

  const kinds = FAMILY_ORDER.filter((k) => points.some((p) => p.kind === k));
  const sorted = useMemo(
    () => [...points].sort((a, b) => Number(b.feasible) - Number(a.feasible) || b.sdBps - a.sdBps),
    [points],
  );
  const baseline = points.find((p) => p.id === baselineId) ?? null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    let best: Point | null = null;
    let bd = 16;
    for (const p of points) {
      const d = Math.hypot(g.sx(p.sdBps) - x, g.sy(p.expectedBps) - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    setHover(best);
  };

  return (
    <figure className={s.frontier}>
      <div className={s.legend}>
        {kinds.map((k) => (
          <span key={k} className={s.legendItem}>
            <span className={s.swatch} style={{ background: familyColor(k, light) }} />
            {familyName(k)}
          </span>
        ))}
        <span className={s.legendItem}>
          <span className={s.swatchHollow} />
          breaks a constraint
        </span>
      </div>
      <div ref={ref} className={s.frontierStage}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${points.length} priced strategies, expected cost against its standard deviation.${g.chosen ? ` Chosen: ${g.chosen.id}, ${bps(g.chosen.expectedBps)} expected, sd ${bps(g.chosen.sdBps)}.` : ""}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {g.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={M.l} x2={W - M.r} y1={g.sy(t)} y2={g.sy(t)} className={s.grid} />
              <text x={M.l - 6} y={g.sy(t) + 3.5} textAnchor="end" className={s.axisText}>
                {num(t, Math.abs(t) < 10 && t % 1 !== 0 ? 1 : 0)}
              </text>
            </g>
          ))}
          {g.xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={g.sx(t)} x2={g.sx(t)} y1={H - M.b} y2={H - M.b + 4} className={s.frame} />
              <text x={g.sx(t)} y={H - M.b + 15} textAnchor="middle" className={s.axisText}>
                {t}
              </text>
            </g>
          ))}
          <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} className={s.frame} />
          <text x={W - M.r} y={H - 4} textAnchor="end" className={s.axisTitle}>
            risk: sd of cost, bp (√ scale)
          </text>
          <text x={4} y={M.t - 2} className={s.axisTitle}>
            expected bp
          </text>
          {g.iso ? <path d={g.iso} className={s.iso} /> : null}
          {sorted.map((p) => {
            const c = familyColor(p.kind, light);
            const x = g.sx(p.sdBps);
            const y = g.sy(p.expectedBps);
            return p.feasible ? (
              <circle key={p.id} cx={x} cy={y} r={4} fill={c} className={s.markerRing} />
            ) : (
              <circle key={p.id} cx={x} cy={y} r={3.5} fill="none" stroke={c} strokeWidth={1.25} />
            );
          })}
          {baseline ? (
            <g>
              <rect
                x={g.sx(baseline.sdBps) - 5}
                y={g.sy(baseline.expectedBps) - 5}
                width={10}
                height={10}
                className={s.baselineMark}
                transform={`rotate(45 ${g.sx(baseline.sdBps)} ${g.sy(baseline.expectedBps)})`}
              />
              <text x={g.sx(baseline.sdBps) + 9} y={g.sy(baseline.expectedBps) + 14} className={s.pointLabel}>
                TWAP baseline
              </text>
            </g>
          ) : null}
          {g.chosen ? (
            <g>
              <circle
                cx={g.sx(g.chosen.sdBps)}
                cy={g.sy(g.chosen.expectedBps)}
                r={9}
                className={s.chosenRing}
              />
              <text
                x={g.sx(g.chosen.sdBps) + 13}
                y={g.sy(g.chosen.expectedBps) - 8}
                className={s.pointLabelStrong}
              >
                chosen
              </text>
            </g>
          ) : null}
          {hover ? (
            <circle cx={g.sx(hover.sdBps)} cy={g.sy(hover.expectedBps)} r={7} className={s.hoverRing} />
          ) : null}
        </svg>
        {hover ? (
          <div
            className={s.tip}
            style={{
              left: Math.min(g.sx(hover.sdBps) + 12, W - 230),
              top: Math.max(0, g.sy(hover.expectedBps) - 70),
            }}
          >
            <div className={s.tipHead}>
              {isBaselineId(hover.id) ? "TWAP baseline" : familyName(hover.kind)}
            </div>
            <div className={s.tipMono}>{hover.id}</div>
            <div className={s.tipRow}>
              <span>expected</span>
              <span>{bps(hover.expectedBps, 2)}</span>
            </div>
            <div className={s.tipRow}>
              <span>sd</span>
              <span>{bps(hover.sdBps, 2)}</span>
            </div>
            <div className={s.tipRow}>
              <span>score (λ {num(lambda, 2)})</span>
              <span>{num(hover.score, 2)}</span>
            </div>
            {hover.feasible ? null : (
              <div className={s.tipNote}>breaks a constraint: shown, never chosen</div>
            )}
          </div>
        ) : null}
      </div>
      <figcaption className={s.caption}>
        The line is every plan that scores the same as the chosen one at λ {num(lambda, 2)}: a point below it
        would have won.
      </figcaption>
    </figure>
  );
}
