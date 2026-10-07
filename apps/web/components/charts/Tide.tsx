"use client";
// The liquidity tide: the New York trading week unrolled as a current. rToken water runs above the centre line,
// perp water below; each bank's height is the recorded depth within ±25 bp of mid for that session (atlas p50),
// its colour the quoted spread (cmocean tempo: brighter = tighter). Particles drift through it, faster where it is
// deep. The live now-line is the only Bitget-teal mark; the plan's slices are released into the current as
// drifters at their scheduled time.
import { useEffect, useMemo, useRef, useState } from "react";
import { nyDayTime, qty, SESSION_SHORT, sessionLabel, usdCompact, venueName } from "@/lib/desk/format";
import { DAY_NAMES, midnights, spansBetween, tradingWeek } from "@/lib/desk/ny";
import type { Session, SessionStats, SliceView, TideData, Venue } from "@/lib/desk/types";
import s from "./charts.module.css";
import { useWidth } from "./hooks";
import { LIVE, type RGB, rgbCss, tightness, waterRgb } from "./ramps";

export interface TideWindow {
  start: number;
  end: number;
  label: string;
}

interface Props {
  tide: TideData;
  now: number;
  slices?: SliceView[] | null;
  window?: TideWindow | null;
  deadline?: number | null;
  light: boolean;
  reduced: boolean;
  height?: number;
}

interface Span {
  session: Session;
  start: number;
  end: number;
  x0: number;
  x1: number;
}

const VENUES: Venue[] = ["rtoken", "perp"];
const GAP = 1.5; // half the surface gap between the two banks
const STEP = 2; // px per sample column
const PAD_TOP = 30;
const PAD_BOTTOM = 30;

function blur(src: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(src.length);
  const sigma = radius / 2;
  const w: number[] = [];
  for (let k = -radius; k <= radius; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as number;
    if (Number.isNaN(c)) {
      out[i] = Number.NaN;
      continue;
    }
    let acc = 0;
    let ws = 0;
    for (let k = -radius; k <= radius; k++) {
      const v = src[i + k];
      if (v === undefined || Number.isNaN(v)) continue;
      const wk = w[k + radius] as number;
      acc += v * wk;
      ws += wk;
    }
    out[i] = ws ? acc / ws : c;
  }
  return out;
}

function runs(th: Float64Array): [number, number][] {
  const out: [number, number][] = [];
  let a = -1;
  for (let i = 0; i <= th.length; i++) {
    const ok = i < th.length && !Number.isNaN(th[i] as number);
    if (ok && a < 0) a = i;
    if (!ok && a >= 0) {
      out.push([a, i - 1]);
      a = -1;
    }
  }
  return out;
}

export function Tide({ tide, now, slices, window: win, deadline, light, reduced, height = 260 }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 320);
  const H = height;

  const model = useMemo(() => {
    const week = tradingWeek(now);
    let end = week.end;
    const last = slices?.length ? Math.max(...slices.map((x) => x.t)) : null;
    if (last && last + 1_800_000 > end) end = last + 3_600_000;
    if (win && win.end + 1_800_000 > end) end = win.end + 3_600_000;
    const start = week.start;

    // Sessions from the desk clock; the server's holiday-aware timeline overrides future spans it covers.
    const raw = spansBetween(start, end).map((sp) => {
      const mid = (sp.start + sp.end) / 2;
      const srv = tide.timeline.find((t) => t.start <= mid && t.end > mid);
      return { ...sp, session: (srv?.session ?? sp.session) as Session };
    });
    const weight = (x: Session) => (x === "weekend" || x === "closed" ? 0.3 : 1);
    const total = raw.reduce((a, sp) => a + (sp.end - sp.start) * weight(sp.session), 0);
    let acc = 0;
    const spans: Span[] = raw.map((sp) => {
      const x0 = (acc / total) * W;
      acc += (sp.end - sp.start) * weight(sp.session);
      return { ...sp, x0, x1: (acc / total) * W };
    });
    const xOf = (t: number) => {
      if (t <= start) return 0;
      if (t >= end) return W;
      const sp = spans.find((q) => q.start <= t && q.end > t);
      if (!sp) return W;
      return sp.x0 + ((t - sp.start) / (sp.end - sp.start)) * (sp.x1 - sp.x0);
    };
    const spanAtX = (x: number) => spans.find((q) => q.x0 <= x && q.x1 > x) ?? spans[spans.length - 1];
    const tOf = (x: number) => {
      const sp = spanAtX(x);
      if (!sp) return start;
      return sp.start + ((x - sp.x0) / Math.max(1e-9, sp.x1 - sp.x0)) * (sp.end - sp.start);
    };

    const stats = new Map<string, SessionStats>();
    for (const row of tide.bySession) for (const v of VENUES) stats.set(`${row.session}|${v}`, row[v]);
    const tradable = new Map<string, boolean>();
    for (const t of tide.timeline)
      for (const v of VENUES)
        if (!tradable.has(`${t.session}|${v}`)) tradable.set(`${t.session}|${v}`, t.venues[v].tradable);
    const isTradable = (sess: Session, v: Venue) =>
      tradable.get(`${sess}|${v}`) ?? (sess === "closed" ? false : v === "perp" || sess !== "weekend");

    // One square-root depth scale for both banks; the centre line sits where the deepest rToken water and the
    // deepest perp water just fill the plot between them.
    const dMax: Record<Venue, number> = { rtoken: 1, perp: 1 };
    for (const row of tide.bySession)
      for (const v of VENUES) {
        const st = row[v];
        if (st) dMax[v] = Math.max(dMax[v], st.depth25UsdP50);
      }
    for (const v of VENUES) {
      const lv = tide.live.venues[v];
      if (lv) dMax[v] = Math.max(dMax[v], lv.depth25Usd);
    }
    const area = H - PAD_TOP - PAD_BOTTOM - 12;
    const k = area / (Math.sqrt(dMax.rtoken) + Math.sqrt(dMax.perp));
    const thick = (d: number) => (d <= 0 ? 0 : Math.max(2.5, k * Math.sqrt(d)));
    const y0 = PAD_TOP + 6 + GAP + k * Math.sqrt(dMax.rtoken);
    const maxHalf = Math.max(k * Math.sqrt(dMax.rtoken), k * Math.sqrt(dMax.perp));
    const nominal = area * 0.2;

    const n = Math.ceil(W / STEP) + 1;
    const th: Record<Venue, Float64Array> = { rtoken: new Float64Array(n), perp: new Float64Array(n) };
    const col: Record<Venue, RGB[]> = { rtoken: [], perp: [] };
    for (let i = 0; i < n; i++) {
      const x = Math.min(W - 0.01, i * STEP);
      const sp = spanAtX(x);
      for (const v of VENUES) {
        if (!sp || !isTradable(sp.session, v)) {
          th[v][i] = 0;
          col[v].push(waterRgb(0, light));
          continue;
        }
        const st = stats.get(`${sp.session}|${v}`);
        if (!st) {
          th[v][i] = Number.NaN;
          col[v].push(waterRgb(0.3, light));
          continue;
        }
        th[v][i] = thick(st.depth25UsdP50);
        col[v].push(waterRgb(tightness(st.spreadBpsP50), light));
      }
    }
    const sm: Record<Venue, Float64Array> = { rtoken: blur(th.rtoken, 9), perp: blur(th.perp, 9) };
    // Smooth the colour too, so session changes read as a current turning, not a wall.
    const smoothCol = (cs: RGB[]): RGB[] =>
      cs.map((_, i) => {
        let r = 0;
        let g = 0;
        let b = 0;
        let k = 0;
        for (let j = Math.max(0, i - 6); j <= Math.min(cs.length - 1, i + 6); j++) {
          const c = cs[j] as RGB;
          r += c[0];
          g += c[1];
          b += c[2];
          k++;
        }
        return [r / k, g / k, b / k];
      });
    const colors = { rtoken: smoothCol(col.rtoken), perp: smoothCol(col.perp) };
    return {
      start,
      end,
      spans,
      xOf,
      tOf,
      spanAtX,
      stats,
      isTradable,
      thick,
      th: sm,
      colors,
      n,
      y0,
      maxHalf,
      nominal,
    };
  }, [tide, now, slices, win, W, H, light]);

  const { spans, xOf, th, colors, n, y0, maxHalf, nominal } = model;
  const xNow = xOf(now);

  // --- bank paths -------------------------------------------------------------------------------------------
  const banks = useMemo(() => {
    const out: { venue: Venue; d: string; edge: string; missing: [number, number][] }[] = [];
    for (const v of VENUES) {
      const t = th[v];
      const dir = v === "rtoken" ? -1 : 1;
      let d = "";
      let edge = "";
      for (const [a, b] of runs(t)) {
        const pts: string[] = [];
        for (let i = a; i <= b; i++)
          pts.push(`${(i * STEP).toFixed(1)},${(y0 + dir * (GAP + (t[i] as number))).toFixed(1)}`);
        d += `M${(a * STEP).toFixed(1)},${(y0 + dir * GAP).toFixed(1)}L${pts.join("L")}L${(b * STEP).toFixed(1)},${(y0 + dir * GAP).toFixed(1)}Z`;
        edge += `M${pts.join("L")}`;
      }
      const missing: [number, number][] = [];
      let m0 = -1;
      for (let i = 0; i <= n; i++) {
        const isNa = i < n && Number.isNaN(t[i] as number);
        if (isNa && m0 < 0) m0 = i;
        if (!isNa && m0 >= 0) {
          missing.push([m0 * STEP, Math.min(W, i * STEP)]);
          m0 = -1;
        }
      }
      out.push({ venue: v, d, edge, missing });
    }
    return out;
  }, [th, n, y0, W]);

  const gradients = useMemo(
    () =>
      VENUES.map((v) => {
        const cs = colors[v];
        const stops: { o: number; c: string }[] = [];
        const every = Math.max(1, Math.round(10 / STEP));
        for (let i = 0; i < cs.length; i += every)
          stops.push({ o: Math.min(1, (i * STEP) / W), c: rgbCss(cs[i] as RGB) });
        return { venue: v, stops };
      }),
    [colors, W],
  );

  // --- particles --------------------------------------------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ th, colors, xNow, W, H, y0, maxHalf });
  live.current = { th, colors, xNow, W, H, y0, maxHalf };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || width === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const L = () => live.current;
    const thAt = (v: Venue, x: number) => {
      const i = Math.max(0, Math.min(L().th[v].length - 1, Math.round(x / STEP)));
      const t = L().th[v][i] as number;
      return Number.isNaN(t) ? 0 : t;
    };
    type P = { x: number; a: number; v: Venue; age: number; life: number; ph: number };
    const N = Math.round(Math.min(900, Math.max(260, W * 0.75)));
    const spawn = (p: P, anywhere: boolean) => {
      for (let k = 0; k < 40; k++) {
        const x = anywhere ? Math.random() * W : Math.random() * W * 0.98;
        const v: Venue = Math.random() < 0.5 ? "rtoken" : "perp";
        const t = thAt(v, x);
        if (t > 1.5 && Math.random() < t / L().maxHalf + 0.03) {
          p.x = x;
          p.v = v;
          break;
        }
      }
      p.a = 0.08 + Math.random() * 0.86;
      p.age = 0;
      p.life = 60 + Math.random() * 160;
      p.ph = Math.random() * 6.283;
    };
    const parts: P[] = [];
    for (let i = 0; i < N; i++) {
      const p: P = { x: 0, a: 0, v: "rtoken", age: 0, life: 0, ph: 0 };
      spawn(p, true);
      p.age = Math.random() * p.life;
      parts.push(p);
    }
    const yOf = (p: P, x: number) => {
      const dir = p.v === "rtoken" ? -1 : 1;
      return L().y0 + dir * (GAP + 1 + p.a * Math.max(0, thAt(p.v, x) - 2));
    };
    const colourAt = (v: Venue, x: number, alpha: number) => {
      const cs = L().colors[v];
      const c = cs[Math.max(0, Math.min(cs.length - 1, Math.round(x / STEP)))] as RGB;
      return rgbCss(c, alpha);
    };

    if (reduced) {
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 0.8;
      for (const p of parts) {
        ctx.beginPath();
        let x = p.x;
        ctx.moveTo(x, yOf(p, x));
        for (let k = 0; k < 22; k++) {
          x += 0.6 + 2.2 * (thAt(p.v, x) / L().maxHalf);
          p.a = Math.max(0.04, Math.min(0.96, p.a + Math.sin(x * 0.03 + p.ph) * 0.01));
          ctx.lineTo(x, yOf(p, x));
        }
        ctx.strokeStyle = colourAt(p.v, p.x, p.x < L().xNow ? 0.22 : 0.5);
        ctx.stroke();
      }
      return;
    }

    let raf = 0;
    let visible = true;
    let t = 0;
    const frame = () => {
      t += 1 / 60;
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      for (const p of parts) {
        const tk = thAt(p.v, p.x);
        if (tk < 1.5 || p.age > p.life || p.x >= W - 1) {
          spawn(p, false);
          continue;
        }
        const x0 = p.x;
        const yA = yOf(p, x0);
        p.x += 0.12 + 1.5 * (tk / L().maxHalf);
        p.a = Math.max(0.04, Math.min(0.96, p.a + Math.sin(p.x * 0.025 + t * 0.8 + p.ph) * 0.006));
        p.age++;
        ctx.strokeStyle = colourAt(p.v, x0, x0 < L().xNow ? 0.25 : 0.8);
        ctx.beginPath();
        ctx.moveTo(x0, yA);
        ctx.lineTo(p.x, yOf(p, p.x));
        ctx.stroke();
      }
      raf = visible && !document.hidden ? requestAnimationFrame(frame) : 0;
    };
    const io = new IntersectionObserver((es) => {
      visible = es.some((e) => e.isIntersecting);
      if (visible && !raf && !document.hidden) raf = requestAnimationFrame(frame);
    });
    io.observe(cv);
    const onVis = () => {
      if (!document.hidden && visible && !raf) raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [W, H, width, reduced]);

  // --- slices as drifters ----------------------------------------------------------------------------------
  const drifters = useMemo(() => {
    if (!slices?.length) return [];
    const sorted = [...slices].sort((a, b) => a.t - b.t);
    const groups: { x: number; venue: Venue; side: "buy" | "sell"; items: SliceView[] }[] = [];
    for (const sl of sorted) {
      const x = xOf(sl.t);
      const g = groups.find((q) => q.venue === sl.venue && Math.abs(q.x - x) < 9);
      if (g) g.items.push(sl);
      else groups.push({ x, venue: sl.venue, side: sl.side, items: [sl] });
    }
    return groups.map((g) => {
      const i = Math.max(0, Math.min(n - 1, Math.round(g.x / STEP)));
      const tk = th[g.venue][i] as number;
      const t = Number.isNaN(tk) ? nominal : tk;
      const dir = g.venue === "rtoken" ? -1 : 1;
      return { ...g, y: y0 + dir * (GAP + Math.max(6, t / 2)) };
    });
  }, [slices, xOf, th, n, nominal, y0]);

  // --- hover ------------------------------------------------------------------------------------------------
  const [hover, setHover] = useState<{ x: number; y: number; drifter: number | null } | null>(null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const di = drifters.findIndex((d) => Math.hypot(d.x - x, d.y - y) < 12);
    setHover({ x: Math.max(0, Math.min(W - 1, x)), y, drifter: di >= 0 ? di : null });
  };

  const hoverInfo = useMemo(() => {
    if (!hover) return null;
    const t = model.tOf(hover.x);
    const sp = model.spanAtX(hover.x);
    if (!sp) return null;
    const rows = VENUES.map((v) => {
      const tradable = model.isTradable(sp.session, v);
      const st = model.stats.get(`${sp.session}|${v}`) ?? null;
      return { v, tradable, st };
    });
    return { t, session: sp.session, rows };
  }, [hover, model]);

  const days = useMemo(() => midnights(model.start, model.end), [model.start, model.end]);
  const ariaSummary = useMemo(() => {
    const parts = tide.bySession
      .map((r) => {
        const a = r.rtoken ? `rToken ${usdCompact(r.rtoken.depth25UsdP50)}` : "rToken no sample";
        const b = r.perp ? `perp ${usdCompact(r.perp.depth25UsdP50)}` : "perp no sample";
        return `${sessionLabel(r.session)}: ${a}, ${b}`;
      })
      .join("; ");
    return `Liquidity tide for ${tide.symbol} over the New York trading week, depth within 25 bp of mid by session. ${parts}.`;
  }, [tide]);

  const missingLabel = useMemo(() => {
    let best: [number, number] | null = null;
    for (const b of banks) for (const m of b.missing) if (!best || m[1] - m[0] > best[1] - best[0]) best = m;
    return best && best[1] - best[0] > 70 ? best : null;
  }, [banks]);

  const xDeadline = deadline && deadline > model.start && deadline < model.end ? xOf(deadline) : null;
  const winX = win ? { a: xOf(win.start), b: Math.max(xOf(win.start) + 3, xOf(win.end)) } : null;
  const liveMarks = VENUES.flatMap((v) => {
    const lv = tide.live.venues[v];
    if (!lv) return [];
    const dir = v === "rtoken" ? -1 : 1;
    return [{ v, y: y0 + dir * (GAP + model.thick(lv.depth25Usd)), lv }];
  });

  const hd = hover?.drifter != null ? drifters[hover.drifter] : null;

  return (
    <div className={s.tideWrap} ref={wrapRef}>
      <div className={s.tideStage} style={{ height: H }}>
        <svg className={s.layer} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <defs>
            {gradients.map((g) => (
              <linearGradient
                key={g.venue}
                id={`tide-${g.venue}`}
                gradientUnits="userSpaceOnUse"
                x1={0}
                x2={W}
                y1={0}
                y2={0}
              >
                {g.stops.map((st) => (
                  <stop key={st.o} offset={st.o} stopColor={st.c} />
                ))}
              </linearGradient>
            ))}
            <pattern
              id="tide-hatch"
              width={6}
              height={6}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1={0} y1={0} x2={0} y2={6} className={s.hatchLine} />
            </pattern>
          </defs>
          {banks.map((b) => (
            <path key={b.venue} d={b.d} fill={`url(#tide-${b.venue})`} opacity={light ? 0.22 : 0.16} />
          ))}
          {banks.map((b) => (
            <path
              key={`e-${b.venue}`}
              d={b.edge}
              fill="none"
              stroke={`url(#tide-${b.venue})`}
              strokeWidth={1.25}
              strokeLinejoin="round"
              opacity={0.95}
            />
          ))}
          {banks.map((b) =>
            b.missing.map(([a, z]) => {
              const dir = b.venue === "rtoken" ? -1 : 1;
              const h = nominal;
              const y = dir < 0 ? y0 - GAP - h : y0 + GAP;
              return (
                <rect
                  key={`${b.venue}-${a}`}
                  x={a}
                  y={y}
                  width={z - a}
                  height={h}
                  fill="url(#tide-hatch)"
                  className={s.missing}
                />
              );
            }),
          )}
        </svg>
        <canvas ref={canvasRef} className={s.layer} style={{ width: W, height: H }} />
        <svg
          className={s.layer}
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={ariaSummary}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* history is dimmed: it already flowed */}
          <rect
            x={0}
            y={PAD_TOP - 6}
            width={Math.max(0, xNow)}
            height={H - PAD_TOP - PAD_BOTTOM + 12}
            className={s.past}
          />
          {/* session frame ticks + labels */}
          <line x1={0} x2={W} y1={PAD_TOP - 8} y2={PAD_TOP - 8} className={s.frame} />
          {spans.map((sp) => (
            <g key={sp.start}>
              <line x1={sp.x0} x2={sp.x0} y1={PAD_TOP - 13} y2={PAD_TOP - 8} className={s.frame} />
              {sp.x1 - sp.x0 > 40 ? (
                <text x={(sp.x0 + sp.x1) / 2} y={PAD_TOP - 15} className={s.sessionText} textAnchor="middle">
                  {SESSION_SHORT[sp.session]}
                </text>
              ) : null}
            </g>
          ))}
          <line x1={0} x2={W} y1={H - PAD_BOTTOM + 8} y2={H - PAD_BOTTOM + 8} className={s.frame} />
          {days.map((d) => (
            <g key={d.ts}>
              <line
                x1={xOf(d.ts)}
                x2={xOf(d.ts)}
                y1={H - PAD_BOTTOM + 8}
                y2={H - PAD_BOTTOM + 14}
                className={s.frame}
              />
              <text x={xOf(d.ts) + 4} y={H - PAD_BOTTOM + 22} className={s.dayText}>
                {DAY_NAMES[d.weekday]} {d.day}
              </text>
            </g>
          ))}
          <text x={6} y={y0 - 8} className={s.bankText}>
            {venueName("rtoken", tide.symbol)}
          </text>
          <text x={6} y={y0 + 16} className={s.bankText}>
            {venueName("perp", tide.symbol)}
          </text>
          {missingLabel ? (
            <text
              x={(missingLabel[0] + missingLabel[1]) / 2}
              y={y0 + 4}
              textAnchor="middle"
              className={s.missingText}
            >
              no atlas sample yet
            </text>
          ) : null}
          {winX ? (
            <g>
              <line
                x1={winX.a}
                x2={winX.b}
                y1={H - PAD_BOTTOM + 2}
                y2={H - PAD_BOTTOM + 2}
                className={s.window}
              />
              <line
                x1={winX.a}
                x2={winX.a}
                y1={H - PAD_BOTTOM - 2}
                y2={H - PAD_BOTTOM + 6}
                className={s.window}
              />
              <line
                x1={winX.b}
                x2={winX.b}
                y1={H - PAD_BOTTOM - 2}
                y2={H - PAD_BOTTOM + 6}
                className={s.window}
              />
            </g>
          ) : null}
          {xDeadline !== null ? (
            <g>
              <line
                x1={xDeadline}
                x2={xDeadline}
                y1={PAD_TOP - 6}
                y2={H - PAD_BOTTOM + 6}
                className={s.deadline}
              />
              <text
                x={xDeadline + (xDeadline > W - 150 ? -5 : 5)}
                y={PAD_TOP + 6}
                textAnchor={xDeadline > W - 150 ? "end" : "start"}
                className={s.deadlineText}
              >
                deadline {nyDayTime(deadline as number)}
              </text>
            </g>
          ) : null}
          {/* now, live */}
          <line x1={xNow} x2={xNow} y1={PAD_TOP - 6} y2={H - PAD_BOTTOM + 6} stroke={LIVE} strokeWidth={1} />
          <text x={xNow + 5} y={PAD_TOP + 6} className={s.nowText} fill={light ? "#0e7385" : LIVE}>
            now {nyDayTime(now).slice(4)} NY
          </text>
          {liveMarks.map((m) => (
            <g key={m.v}>
              <line
                x1={xNow - 7}
                x2={xNow + 7}
                y1={m.y}
                y2={m.y}
                stroke={LIVE}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </g>
          ))}
          {drifters.map((d, i) => (
            <g key={`${d.venue}-${d.x}`} className={s.drifter}>
              <circle cx={d.x} cy={d.y} r={d.items.length > 1 ? 6.5 : 5} className={s.ring} />
              <circle
                cx={d.x}
                cy={d.y}
                r={d.items.length > 1 ? 5 : 3.75}
                className={d.side === "buy" ? s.buyDot : s.sellDot}
              />
              {d.items.length > 1 ? (
                <text x={d.x + 9} y={d.y + (d.venue === "rtoken" ? -6 : 12)} className={s.drifterText}>
                  {d.items.length} slices
                </text>
              ) : null}
              {i === 0 && d.items.length === 1 ? (
                <text x={d.x + 8} y={d.y + (d.venue === "rtoken" ? -6 : 12)} className={s.drifterText}>
                  slice 1
                </text>
              ) : null}
            </g>
          ))}
          {hover ? (
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD_TOP - 6}
              y2={H - PAD_BOTTOM + 6}
              className={s.crosshair}
            />
          ) : null}
        </svg>
        {hover && hoverInfo ? (
          <div
            className={s.tip}
            style={{
              left: Math.min(Math.max(8, hover.x + 14), W - 250),
              top: 34,
            }}
          >
            {hd ? (
              <>
                <div className={s.tipHead}>
                  {hd.items.length > 1
                    ? `Slices ${(hd.items[0]?.index ?? 0) + 1}–${(hd.items.at(-1)?.index ?? 0) + 1}`
                    : `Slice ${(hd.items[0]?.index ?? 0) + 1}`}{" "}
                  on {venueName(hd.venue, tide.symbol)}
                </div>
                {hd.items.slice(0, 4).map((it) => (
                  <div key={it.index} className={s.tipRow}>
                    <span>{nyDayTime(it.t)}</span>
                    <span>
                      {it.side} {qty(it.qty)} · {it.type}
                    </span>
                  </div>
                ))}
                {hd.items.length > 4 ? <div className={s.tipNote}>and {hd.items.length - 4} more</div> : null}
              </>
            ) : (
              <>
                <div className={s.tipHead}>
                  {nyDayTime(hoverInfo.t)} NY, {sessionLabel(hoverInfo.session)}
                </div>
                {hoverInfo.rows.map((r) => (
                  <div key={r.v} className={s.tipRow}>
                    <span>{venueName(r.v, tide.symbol)}</span>
                    <span>
                      {!r.tradable
                        ? "not trading"
                        : r.st
                          ? `${usdCompact(r.st.depth25UsdP50)} deep, ${r.st.spreadBpsP50.toFixed(2)} bp wide`
                          : "no atlas sample"}
                    </span>
                  </div>
                ))}
                <div className={s.tipNote}>atlas median for this session, depth per side within ±25 bp</div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
