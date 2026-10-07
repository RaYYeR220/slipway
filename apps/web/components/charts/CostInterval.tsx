"use client";
// One strategy on the shared bps axis: the p10–p90 band as an interval, a deterministic ensemble of drifters drawn
// from N(expected, sd) inside it, the expected cost as the marker, and under it the expected cost split into its
// components (spread / impact / fees / funding) as a stacked strip from zero.
import { bps, num } from "@/lib/desk/format";
import type { QuoteView } from "@/lib/desk/types";
import s from "./charts.module.css";
import { COMPONENT_COLOR, familyColor } from "./ramps";
import { ensemble } from "./scale";

interface Props {
  q: QuoteView;
  lo: number;
  hi: number;
  width: number;
  light: boolean;
  chosen?: boolean;
  colorKind?: string;
}

const PAD = 8;
const H = 46;
const YI = 17;
const YS = 36;

const COMPONENTS = ["spread", "impact", "fees", "funding"] as const;

export function CostInterval({ q, lo, hi, width, light, chosen, colorKind }: Props) {
  const w = Math.max(120, width);
  const sx = (v: number) => PAD + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (w - 2 * PAD);
  const color = familyColor(colorKind ?? q.kind, light);
  const clipLo = q.p10Bps < lo;
  const clipHi = q.p90Bps > hi;
  const dots =
    q.sdBps > 0.05 ? ensemble(q.expectedBps, q.sdBps, 36).filter((d) => d.v >= lo && d.v <= hi) : [];

  // Expected-cost parts: positives stack right from zero, negatives (rebates, funding received) stack left.
  let posX = 0;
  let negX = 0;
  const segs: { k: string; a: number; b: number }[] = [];
  for (const k of COMPONENTS) {
    const v = q.components[k] ?? 0;
    if (Math.abs(v) < 1e-6) continue;
    if (v > 0) {
      segs.push({ k, a: posX, b: posX + v });
      posX += v;
    } else {
      segs.push({ k, a: negX + v, b: negX });
      negX += v;
    }
  }
  const label = `${q.label}: expected ${bps(q.expectedBps)}, 80% band ${bps(q.p10Bps)} to ${bps(q.p90Bps)}; ${COMPONENTS.map(
    (k) => `${k} ${num(q.components[k] ?? 0)}`,
  ).join(", ")}`;

  return (
    <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={label} className={s.interval}>
      {lo < 0 && hi > 0 ? <line x1={sx(0)} x2={sx(0)} y1={4} y2={H - 2} className={s.zero} /> : null}
      <line x1={PAD} x2={w - PAD} y1={YI} y2={YI} className={s.track} />
      {dots.map((d) => (
        <circle key={`${d.v}-${d.j}`} cx={sx(d.v)} cy={YI + d.j * 13} r={1.35} fill={color} opacity={0.5} />
      ))}
      <line
        x1={sx(q.p10Bps)}
        x2={Math.max(sx(q.p90Bps), sx(q.p10Bps) + 0.5)}
        y1={YI}
        y2={YI}
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      {clipLo ? (
        <>
          <path
            d={`M${PAD + 6},${YI - 4}L${PAD},${YI}L${PAD + 6},${YI + 4}`}
            stroke={color}
            fill="none"
            strokeWidth={1.5}
          />
          <text x={PAD + 9} y={YI - 6} className={s.clipText}>
            {num(q.p10Bps)}
          </text>
        </>
      ) : null}
      {clipHi ? (
        <>
          <path
            d={`M${w - PAD - 6},${YI - 4}L${w - PAD},${YI}L${w - PAD - 6},${YI + 4}`}
            stroke={color}
            fill="none"
            strokeWidth={1.5}
          />
          <text x={w - PAD - 9} y={YI - 6} className={s.clipText} textAnchor="end">
            {num(q.p90Bps)}
          </text>
        </>
      ) : null}
      {chosen ? <circle cx={sx(q.expectedBps)} cy={YI} r={8} className={s.chosenRing} /> : null}
      <circle cx={sx(q.expectedBps)} cy={YI} r={4.5} fill={color} className={s.markerRing} />
      {segs.map((g) => {
        const a = sx(g.a);
        const b = sx(g.b);
        const wd = Math.max(0, Math.abs(b - a) - 2);
        return (
          <rect
            key={g.k}
            x={Math.min(a, b) + 1}
            y={YS}
            width={wd}
            height={5}
            rx={1}
            fill={COMPONENT_COLOR[g.k as keyof typeof COMPONENT_COLOR]}
          />
        );
      })}
    </svg>
  );
}
