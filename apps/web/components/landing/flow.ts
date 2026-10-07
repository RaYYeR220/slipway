// The landing's current (design variant v05d "final": v05a's laminar current at full scale, v05b's stick in the
// stream, v05's loose figure). Thousands of particles are advected through a smooth field built from the real
// hour-of-week series: one meandering jet runs the trading week left to right (top to bottom on phones); its
// width, speed and brightness are the log of the median USDT traded in each hour, so every New York session
// swells into a tall bulge and the weekend is a thread. Eddies sit where the median hourly range peaks (the
// open, the close). A slow, dim shoulder of edge flow spreads either side, so the copy sits on the current's
// fringes. The headline is coastline: the field is routed around it and a feathered mask keeps it on dark water.
//
// Pointer: a stick in the stream (potential flow past a cylinder plus a short oscillating wake), with a hairline
// readout of that hour's real value and range. Over the figure, the crisp glyph dissolves into its particles,
// which scatter from the pointer and spring back; the crisp glyph returns once the pointer has been still.
// Reduced motion: one long-exposure still, crisp figure, readout only.
//
// startFlow mounts on the hero's elements and returns a cleanup that stops every loop and listener and releases
// the WebGL context. The trail canvases are created here (fresh per mount), inside `host`.

import {
  createTrails2D,
  createTrailsGL,
  type MaskRect,
  STRIDE,
  TRAIL_FADE,
  type Trails,
} from "./hero/trails";
import {
  blur1,
  clamp,
  clock,
  DAYS,
  depthScale,
  fmtUsd,
  gauss,
  hex,
  makeNoise,
  minFilter,
  nowET,
  type Rect,
  type RGB,
  ramp,
  rampLUT,
  sdRect,
  sessionOf,
  smin,
  smooth,
  wrap,
} from "./hero/util";

export interface FlowData {
  /** 168 values, index 0 = Sunday 00:00 New York: median USDT traded in that hour. */
  vol: readonly number[];
  /** 168 values: median high-low range of that hour, in bp. */
  rng: readonly number[];
  /** The figure that condenses out of the current (rendered as `${ratio}×`); null hides it. */
  ratio: number | null;
  /** How many weeks each median covers, for the readout. */
  weeks?: number;
}

export interface FlowElements {
  sea: HTMLElement;
  /** Empty container; the engine creates its canvases in it. */
  host: HTMLElement;
  /** The crisp figure; the engine sizes and draws it. Null when there is no figure. */
  num: HTMLCanvasElement | null;
  figcap: HTMLElement | null;
  figsrc: HTMLElement | null;
  claim: HTMLElement;
  copy: HTMLElement;
  legend: HTMLElement;
  probe: HTMLElement;
  probeLn: HTMLElement;
  probeLb: HTMLElement;
}

const DEF_TEMPO = [
  "#151D44",
  "#1B3C56",
  "#1B5968",
  "#117777",
  "#2A937F",
  "#69AB89",
  "#A1C1A1",
  "#D2D9C7",
  "#FFF6F4",
];
const DEF_SOLAR = ["#331418", "#5B2023", "#822D22", "#A04519", "#B66413", "#C78616", "#D4AB23", "#DDD236"];
const COND_T0 = 0.5;
const WAKE_A = 0.17;
const WAKE_D = 0.55;
const f32 = (a: Float32Array, i: number) => a[i] as number;

interface Layout {
  W: number;
  H: number;
  vertical: boolean;
  /** Length along the week (x on desktop, y on phones) and across it. */
  S: number;
  N: number;
  pxh: number;
  R: { claim: Rect; rest: Rect; num: Rect; cap: Rect; legend: Rect; hdr: Rect; fig: Rect };
  roomBlocks: Rect[];
  probeBlocks: Rect[];
}
interface Eddy {
  s: number;
  n: number;
  R: number;
  S: number;
  sig: number;
}
interface Geo {
  K: Float32Array;
  C: Float32Array;
  WA: Float32Array;
  WB: Float32Array;
  U: Float32Array;
  RA: Float32Array;
  RB: Float32Array;
  vort: Eddy[];
}
interface Field {
  st: number;
  gx: number;
  gy: number;
  VX: Float32Array;
  VY: Float32Array;
  DIM: Float32Array;
}
interface Cfg {
  meander: number;
  mobileSide: number;
  mobileSwing: number;
  pad: number;
  tail: number;
  wMin: number;
  wA: (k: number) => number;
  wB: (k: number) => number;
  U: (k: number) => number;
  eddyRmax: number;
  eddyR: number;
}

/** Capture-only switches, read from the URL and nowhere else; without `capture=1` nothing changes. `capture=1`
 * fixes the particle budget (no adaptive shedding or brightening) and the frame step; `speed` scales advection;
 * `fade` sets trail persistence per frame (default: the visible length and light of the normal trails, held). */
function captureParams(): { speed: number; fade: number } | null {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("capture") !== "1") return null;
    const speed = clamp(Number(q.get("speed") ?? "1") || 1, 0.1, 2);
    const fade = clamp(Number(q.get("fade") ?? "") || 1 - (1 - TRAIL_FADE) * speed, 0.9, 0.999);
    return { speed, fade };
  } catch {
    return null;
  }
}

/** Mounts the hero's current. Returns a cleanup that stops every loop and listener and frees the GL context. */
export function startFlow(el: FlowElements, data: FlowData): () => void {
  const { sea } = el;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CAP = captureParams();
  const rs = getComputedStyle(document.documentElement);
  const tok = (name: string, fb: string) => {
    const v = rs.getPropertyValue(name).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fb;
  };
  const TEMPO = DEF_TEMPO.map((h, i) => tok(`--t-${i + 1}`, h));
  const SOLAR = DEF_SOLAR.map((h, i) => tok(`--so-${i + 1}`, h));
  const BG = hex(tok("--ab-950", "#050C10")).map((c) => c / 255) as [number, number, number];
  const LIVE = tok("--live", "#26BFD4");
  const TLUT = rampLUT(TEMPO.map(hex), 256);
  const GOLD: [number, string][] = [
    [0, SOLAR[7] as string],
    [0.42, SOLAR[6] as string],
    [0.8, SOLAR[5] as string],
    [1, SOLAR[4] as string],
  ];
  const GOLDRGB: [number, RGB][] = GOLD.map(([p, h]) => [p, hex(h)]);
  const NOISE = makeNoise(11);
  const figText = data.ratio === null ? "" : String(data.ratio);
  const hasFig = !!el.num && figText !== "";

  /* ---- data: log volume -> depth k (0..1), smoothed through the hour ---- */
  const vol = data.vol.map((v) => Number(v) || 0);
  const rng = data.rng.map((v) => Number(v) || 0);
  const LOGV = vol.map((v) => Math.log10(Math.max(v, 1)));
  const depth = depthScale(vol);
  const logAt = (k: number) => LOGV[wrap(k)] as number;
  const lw = (h: number) => {
    const u = h - 0.5;
    const i = Math.floor(u);
    const f = u - i;
    const p0 = logAt(i - 1);
    const p1 = logAt(i);
    const p2 = logAt(i + 1);
    const p3 = logAt(i + 2);
    return (
      0.5 *
      (2 * p1 +
        (-p0 + p2) * f +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
        (-p0 + 3 * p1 - 3 * p2 + p3) * f ** 3)
    );
  };
  const KW = [1, 2, 3, 4, 3, 2, 1];
  const kSm = (h: number) => {
    let a = 0;
    for (let j = -3; j <= 3; j++) a += lw(h + j * 0.3) * (KW[j + 3] as number);
    return depth.k(a / 16);
  };
  const volAt = (h: number) => vol[Math.floor(wrap(h))] as number;
  const rngAt = (h: number) => rng[Math.floor(wrap(h))] as number;
  // eddy threshold: the top ~16% of weekday hourly ranges (about 60 bp on a five-week sample)
  const wk: number[] = [];
  for (let d = 1; d <= 5; d++) for (let h = 0; h < 24; h++) wk.push(rng[d * 24 + h] ?? 0);
  wk.sort((a, b) => a - b);
  const THR = clamp(wk[Math.floor(wk.length * 0.84)] || 60, 40, 90);

  /* ---- canvases: the trail layer and the frame (axis, now-line), created per mount ---- */
  const mkCanvas = () => {
    const c = document.createElement("canvas");
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
    return c;
  };
  let flowCv = mkCanvas();
  const uiCv = mkCanvas();
  el.host.append(flowCv, uiCv);

  /* ---- layout: the week runs along s (x on desktop, y on phones); n is across the current ---- */
  let G: Layout;
  let geo: Geo;
  let F: Field;
  const sOf = (h: number) => h * G.pxh;
  const hOf = (s: number) => s / G.pxh;
  const toXY = (s: number, n: number): [number, number] => (G.vertical ? [n, s] : [s, n]);
  const toSN = (x: number, y: number): [number, number] => (G.vertical ? [y, x] : [x, y]);
  const rectSN = (b: Rect) =>
    G.vertical ? { s0: b.y0, s1: b.y1, n0: b.x0, n1: b.x1 } : { s0: b.x0, s1: b.x1, n0: b.y0, n1: b.y1 };

  function readLayout(): Layout {
    const r = sea.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width));
    const H = Math.max(1, Math.round(r.height));
    const vertical = W <= 760;
    const rel = (e: Element | null): Rect | null => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      if (!b.width && !b.height) return null;
      return { x0: b.left - r.left, y0: b.top - r.top, x1: b.right - r.left, y1: b.bottom - r.top };
    };
    const uni = (a: Rect, b: Rect | null): Rect =>
      b
        ? {
            x0: Math.min(a.x0, b.x0),
            y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1),
          }
        : a;
    const none: Rect = { x0: W, y0: 0, x1: W, y1: 0 };
    const claim = rel(el.claim) ?? none;
    const copy = rel(el.copy) ?? claim;
    const num = (hasFig ? rel(el.num) : null) ?? none;
    const capR = rel(el.figcap);
    const cap = capR ? uni(capR, rel(el.figsrc)) : num;
    const legend = rel(el.legend) ?? none;
    const rest: Rect = { x0: copy.x0, y0: claim.y1, x1: copy.x1, y1: copy.y1 };
    // the site header floats over the hero; its bottom edge is the top of the water
    let hdr: Rect = { x0: 0, y0: 0, x1: W, y1: vertical ? 110 : 88 };
    for (const h of Array.from(document.querySelectorAll("header"))) {
      if (sea.contains(h)) continue;
      const b = rel(h);
      if (b && b.y1 > 0 && b.y0 < H * 0.3) {
        hdr = { x0: 0, y0: 0, x1: W, y1: b.y1 };
        break;
      }
    }
    const R = { claim, rest, num, cap, legend, hdr, fig: uni(num, cap) };
    const S = vertical ? H : W;
    const N = vertical ? W : H;
    const axis: Rect = { x0: -40, y0: H - 30, x1: W + 40, y1: H + 40 };
    return {
      W,
      H,
      vertical,
      S,
      N,
      pxh: S / 168,
      R,
      roomBlocks: vertical
        ? [claim, rest, num, cap, legend, hdr]
        : [claim, rest, num, cap, legend, hdr, axis],
      probeBlocks: [claim, rest, R.fig, legend, hdr],
    };
  }

  /* centreline. Desktop: the diagonal between the claim (bottom left) and the figure (top right), with a two-wave
     meander. Phones: a river beside the text column that swings across open water between the figure and the claim. */
  function centreline(c: Cfg): Float32Array {
    const { S, N, R } = G;
    const C = new Float32Array(S + 1);
    if (!G.vertical) {
      const cL = (R.hdr.y1 + R.claim.y0) / 2;
      const cR = (R.cap.y1 + G.H - 30) / 2;
      const a = R.claim.x1 - G.W * 0.13;
      const b = Math.max(a + 160, R.num.x0 + G.W * 0.03);
      for (let s = 0; s <= S; s++) {
        const u = s / S;
        C[s] =
          cL +
          (cR - cL) * smooth(a, b, s) +
          N *
            (c.meander * Math.sin(2 * Math.PI * 1.55 * u + 0.9) +
              c.meander * 0.45 * Math.sin(2 * Math.PI * 3.7 * u + 2.4));
      }
    } else {
      const textR = Math.max(R.cap.x1 < G.W ? R.cap.x1 : 0, R.rest.x1, R.claim.x1);
      const cT = textR + (G.W - textR) * c.mobileSide;
      const cMid = G.W * c.mobileSwing;
      const g0 = R.cap.y1 + 14;
      const g1 = R.claim.y0 - 14;
      for (let s = 0; s <= S; s++) {
        const u = s / S;
        const inGap = smooth(g0 - 60, g0 + 70, s) * (1 - smooth(g1 - 140, g1 - 30, s));
        C[s] = cT + (cMid - cT) * inGap + N * c.meander * Math.sin(2 * Math.PI * 2.1 * u + 0.4);
      }
    }
    return C;
  }
  /* room between the centreline and the nearest block on each side (A = towards smaller n, B = larger n) */
  function roomOf(C: Float32Array, pad: number): [Float32Array, Float32Array] {
    const { S } = G;
    const RA = new Float32Array(S + 1).fill(1e4);
    const RB = new Float32Array(S + 1).fill(1e4);
    for (const b of G.roomBlocks) {
      const q = rectSN(b);
      for (let s = Math.max(0, Math.floor(q.s0 - pad)); s <= Math.min(S, Math.ceil(q.s1 + pad)); s++) {
        const ds = Math.max(0, q.s0 - s, s - q.s1);
        const soft = Math.sqrt(Math.max(0, pad * pad - ds * ds));
        const lo = q.n0 - soft;
        const hi = q.n1 + soft;
        const c = f32(C, s);
        if (hi <= c) RA[s] = Math.min(f32(RA, s), c - hi);
        else if (lo >= c) RB[s] = Math.min(f32(RB, s), lo - c);
        else {
          RA[s] = Math.min(f32(RA, s), 0);
          RB[s] = Math.min(f32(RB, s), 0);
        }
      }
    }
    return [RA, RB];
  }
  function cfgFor(): Cfg {
    const v = G.vertical;
    return {
      meander: v ? 0.04 : 0.042,
      mobileSide: 0.42,
      mobileSwing: 0.4,
      pad: v ? 12 : 22,
      tail: v ? 1.0 : 1.32,
      wMin: v ? 5 : 7,
      wA: (k) => (v ? 9 + 84 * k ** 2.4 : 10 + 150 * k ** 2.4),
      wB: (k) => (v ? 10 + 100 * k ** 2.4 : 12 + 185 * k ** 2.4),
      U: (k) => 0.06 + (v ? 2.6 : 3.4) * k ** 2.3,
      eddyRmax: v ? 0.1 * G.W : 0.072 * G.H,
      eddyR: 0.5,
    };
  }
  function buildGeometry(c: Cfg): Geo {
    const S = G.S;
    const K = new Float32Array(S + 1);
    const U = new Float32Array(S + 1);
    for (let s = 0; s <= S; s++) K[s] = kSm(hOf(s));
    const C = centreline(c);
    let [RA, RB] = roomOf(C, c.pad);
    RA = blur1(minFilter(RA, 40), 18);
    RB = blur1(minFilter(RB, 40), 18);
    let WA = new Float32Array(S + 1);
    let WB = new Float32Array(S + 1);
    for (let s = 0; s <= S; s++) {
      const k = f32(K, s);
      WA[s] = Math.max(c.wMin, smin(c.wA(k), Math.max(1, f32(RA, s)) / c.tail));
      WB[s] = Math.max(c.wMin, smin(c.wB(k), Math.max(1, f32(RB, s)) / c.tail));
      U[s] = c.U(k);
    }
    WA = blur1(WA, 15);
    WB = blur1(WB, 15);
    // eddies: one per cluster of hours whose real median range is in the top band, at the open and the close
    const vort: Eddy[] = [];
    let h = 0;
    while (h < 168) {
      if (rngAt(h) < THR) {
        h++;
        continue;
      }
      let h2 = h;
      let mx = 0;
      let ws = 0;
      let acc = 0;
      while (h2 < 168 && rngAt(h2) >= THR) {
        const r = rngAt(h2);
        mx = Math.max(mx, r);
        acc += (h2 + 0.5) * r;
        ws += r;
        h2++;
      }
      const hc = acc / ws;
      const s = Math.round(sOf(hc));
      const hod = hc % 24;
      const k = f32(K, clamp(s, 0, S));
      if (s > 6 && s < S - 6 && k > 0.35 && hod >= 8 && hod <= 17) {
        const sideA = hod < 13;
        const w = sideA ? f32(WA, s) : f32(WB, s);
        const room = sideA ? f32(RA, s) : f32(RB, s);
        const R0 = clamp(w * c.eddyR, 10, c.eddyRmax);
        let off = w + R0 * 0.3;
        if (off + R0 * 1.05 > room) off = Math.max(w * 0.72, room - R0 * 1.05);
        if (room > w * 0.72 + R0 * 0.9)
          vort.push({
            s,
            n: f32(C, s) + (sideA ? -off : off),
            R: R0,
            S: Math.min(1.6, 0.55 + (mx - THR) / 80),
            sig: sideA ? -1 : 1,
          });
      }
      h = h2;
    }
    return { K, C, WA, WB, U, RA, RB, vort };
  }

  /* velocity grid (px per 60 Hz frame). The jet is geometric: water follows lines of constant relative offset z = d/w,
     so it widens, narrows and meanders with the channel; a slow, wide shoulder runs beside it. The ambient sea (drift,
     curl noise, the eddies) is a stream function, so it is divergence-free; the claim is an island in it. */
  function buildField(): Field {
    const st = 4;
    const gx = Math.ceil(G.W / st) + 2;
    const gy = Math.ceil(G.H / st) + 2;
    const n = gx * gy;
    const PSI = new Float32Array(n);
    const VX = new Float32Array(n);
    const VY = new Float32Array(n);
    const DIM = new Float32Array(n);
    const { C, WA, WB, U, vort } = geo;
    const S = G.S;
    const sg = G.vertical ? -1 : 1;
    const R = G.R;
    const Ubg = 0.05;
    const noiseA = 9;
    const noiseL = 260;
    const pad = 14;
    const D0 = 44;
    const dimR = 60;
    const fringe = 0.24;
    const fringeZ = 3.0;
    const soft = [
      { b: R.rest, f: 0.7, r: 60 },
      { b: R.cap, f: 0.4, r: 60 },
      { b: R.num, f: 0.35, r: 50 },
      { b: R.legend, f: 0.4, r: 40 },
    ];
    const dC = new Float32Array(S + 1);
    const dA = new Float32Array(S + 1);
    const dB = new Float32Array(S + 1);
    for (let s = 0; s <= S; s++) {
      const a = Math.max(0, s - 2);
      const b = Math.min(S, s + 2);
      dC[s] = (f32(C, b) - f32(C, a)) / (b - a);
      dA[s] = (f32(WA, b) - f32(WA, a)) / (b - a);
      dB[s] = (f32(WB, b) - f32(WB, a)) / (b - a);
    }
    const raw = (x: number, y: number) => {
      const s = G.vertical ? y : x;
      const nn = G.vertical ? x : y;
      let p = Ubg * nn + noiseA * NOISE(x / noiseL + 3.1, y / noiseL + 7.7);
      for (const v of vort) {
        const ds = s - v.s;
        const dn = nn - v.n;
        const r2 = (ds * ds + dn * dn) / (v.R * v.R);
        if (r2 < 9) p += v.sig * v.S * v.R * Math.exp(-r2);
      }
      return sg * p;
    };
    const isl = [R.claim].map((b) => ({
      x0: b.x0 - pad,
      y0: b.y0 - pad,
      x1: b.x1 + pad,
      y1: b.y1 + pad,
      psi: raw((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2),
    }));
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++) {
        const x = i * st;
        const y = j * st;
        let p = raw(x, y);
        for (const b of isl) {
          const d = sdRect(x, y, b);
          if (d < D0) {
            const r = ramp(Math.max(0, d) / D0);
            p = r * p + (1 - r) * b.psi;
          }
        }
        PSI[j * gx + i] = p;
      }
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++) {
        const k = j * gx + i;
        const x = i * st;
        const y = j * st;
        const jp = Math.min(gy - 1, j + 1);
        const jm = Math.max(0, j - 1);
        const ip = Math.min(gx - 1, i + 1);
        const im = Math.max(0, i - 1);
        let vx = (f32(PSI, jp * gx + i) - f32(PSI, jm * gx + i)) / ((jp - jm) * st);
        let vy = -(f32(PSI, j * gx + ip) - f32(PSI, j * gx + im)) / ((ip - im) * st);
        const s = G.vertical ? y : x;
        const nn = G.vertical ? x : y;
        const si = clamp(Math.round(s), 0, S);
        const d = nn - f32(C, si);
        const side = d < 0;
        const w = side ? f32(WA, si) : f32(WB, si);
        const z = d / w;
        const zf = z / fringeZ;
        let isl1 = 1;
        let dim = 1;
        for (const b of isl) {
          const dd = sdRect(x, y, b);
          if (dd < D0) isl1 = Math.min(isl1, ramp(Math.max(0, dd) / D0));
          dim = Math.min(dim, smooth(0, dimR, dd));
        }
        for (const q of soft) dim = Math.min(dim, q.f + (1 - q.f) * smooth(0, q.r, sdRect(x, y, q.b)));
        DIM[k] = dim;
        const us = f32(U, si) * (Math.exp(-z * z) + fringe * Math.exp(-zf * zf)) * isl1;
        const un = us * (f32(dC, si) + clamp((d * (side ? f32(dA, si) : f32(dB, si))) / w, -1.2, 1.2));
        if (G.vertical) {
          vx += un;
          vy += us;
        } else {
          vx += us;
          vy += un;
        }
        VX[k] = vx;
        VY[k] = vy;
      }
    return { st, gx, gy, VX, VY, DIM };
  }
  const _v = new Float32Array(2);
  function sampleV(x: number, y: number): Float32Array {
    const { st, gx, gy, VX, VY } = F;
    const fx = x / st;
    const fy = y / st;
    let i = fx | 0;
    let j = fy | 0;
    if (i < 0) i = 0;
    if (j < 0) j = 0;
    if (i > gx - 2) i = gx - 2;
    if (j > gy - 2) j = gy - 2;
    const u = clamp(fx - i, 0, 1);
    const v = clamp(fy - j, 0, 1);
    const k = j * gx + i;
    const k2 = k + gx;
    const a = (1 - u) * (1 - v);
    const b = u * (1 - v);
    const c = (1 - u) * v;
    const d = u * v;
    _v[0] = f32(VX, k) * a + f32(VX, k + 1) * b + f32(VX, k2) * c + f32(VX, k2 + 1) * d;
    _v[1] = f32(VY, k) * a + f32(VY, k + 1) * b + f32(VY, k2) * c + f32(VY, k2 + 1) * d;
    return _v;
  }
  const dimAt = (x: number, y: number) =>
    f32(F.DIM, clamp(Math.round(y / F.st), 0, F.gy - 1) * F.gx + clamp(Math.round(x / F.st), 0, F.gx - 1));

  /* ---- the pointer is a stick in the stream: potential flow past a cylinder of radius a (a doublet on the flow
     relative to the stick, so a moving stick parts still water too), plus a short oscillating wake downstream ---- */
  const PTR = {
    x: -1e4,
    y: -1e4,
    tx: -1e4,
    ty: -1e4,
    px: -1e4,
    py: -1e4,
    vx: 0,
    vy: 0,
    k: 0,
    on: false,
    a: 30,
    reach: 200,
    ux: 1,
    uy: 0,
    U: 0,
    ph: 0,
    kw: 0.1,
    wakeL: 190,
    last: 0,
  };
  function stick(x: number, y: number, v: Float32Array) {
    const dx = x - PTR.x;
    const dy = y - PTR.y;
    const L = PTR.reach;
    if (dx > L || dx < -L || dy > L || dy < -L) return;
    const r2 = dx * dx + dy * dy;
    if (r2 > L * L) return;
    const a = PTR.a;
    const a2 = a * a;
    const Vx = f32(v, 0) - PTR.vx;
    const Vy = f32(v, 1) - PTR.vy;
    let ox = 0;
    let oy = 0;
    if (r2 < 16 * a2) {
      // doublet: v' = -conj(V) a^2 / conj(z)^2, tapered to nothing by 4a
      const r2s = Math.max(r2, 1e-3);
      const c2 = (dx * dx - dy * dy) / r2s;
      const s2 = (2 * dx * dy) / r2s;
      const q = a2 / Math.max(r2, 0.81 * a2);
      const r = Math.sqrt(r2s);
      const tap = 1 - smooth(2.6 * a, 4 * a, r);
      ox -= q * (Vx * c2 + Vy * s2) * tap;
      oy -= q * (Vx * s2 - Vy * c2) * tap;
      if (r2 < a2) {
        const push = (1 - r / a) * (1.1 + 0.5 * Math.sqrt(Vx * Vx + Vy * Vy));
        ox += (dx / r) * push;
        oy += (dy / r) * push;
      }
    }
    const xi = dx * PTR.ux + dy * PTR.uy;
    if (xi > 0.2 * a && xi < PTR.wakeL && PTR.U > 0.02) {
      // wake: an oscillating stream function (a short vortex street) plus a velocity deficit behind the stick
      const eta = -dx * PTR.uy + dy * PTR.ux;
      const sg = a * (0.55 + (0.09 * xi) / a);
      const e2 = eta / sg;
      const g = Math.exp(-e2 * e2);
      if (g > 0.01) {
        const env = smooth(0.2 * a, 1.4 * a, xi) * Math.exp(-Math.max(0, xi - 1.4 * a) / (2.6 * a));
        const ph = PTR.kw * xi - PTR.ph;
        const amp = WAKE_A * PTR.U * a * g * env;
        const uxi = amp * ((-2 * eta) / (sg * sg)) * Math.sin(ph) - WAKE_D * PTR.U * g * env;
        const ueta = -amp * PTR.kw * Math.cos(ph);
        ox += uxi * PTR.ux - ueta * PTR.uy;
        oy += uxi * PTR.uy + ueta * PTR.ux;
      }
    }
    v[0] = f32(v, 0) + ox * PTR.k;
    v[1] = f32(v, 1) + oy * PTR.k;
  }
  function stickFrame(dtf: number) {
    if (PTR.on) {
      if (PTR.x < -1e3 || PTR.k < 0.05) {
        PTR.x = PTR.tx;
        PTR.y = PTR.ty;
        PTR.px = PTR.x;
        PTR.py = PTR.y;
      }
      PTR.x += (PTR.tx - PTR.x) * Math.min(1, 0.3 * dtf);
      PTR.y += (PTR.ty - PTR.y) * Math.min(1, 0.3 * dtf);
      PTR.k += (1 - PTR.k) * Math.min(1, 0.07 * dtf);
    } else PTR.k *= 0.9 ** dtf;
    // the stick's own velocity (eased, capped): a moving stick parts still water and drags a wake
    let mvx = (PTR.x - PTR.px) / dtf;
    let mvy = (PTR.y - PTR.py) / dtf;
    const ms = Math.hypot(mvx, mvy);
    if (ms > 3.5) {
      mvx *= 3.5 / ms;
      mvy *= 3.5 / ms;
    }
    PTR.vx += (mvx - PTR.vx) * 0.25;
    PTR.vy += (mvy - PTR.vy) * 0.25;
    PTR.px = PTR.x;
    PTR.py = PTR.y;
    if (PTR.k < 0.004) return;
    const f = sampleV(PTR.x, PTR.y);
    const rx = f32(f, 0) - PTR.vx;
    const ry = f32(f, 1) - PTR.vy;
    const U = Math.hypot(rx, ry);
    PTR.U += (U - PTR.U) * 0.12;
    if (U > 0.02) {
      PTR.ux += (rx / U - PTR.ux) * 0.15;
      PTR.uy += (ry / U - PTR.uy) * 0.15;
      const n = Math.hypot(PTR.ux, PTR.uy) || 1;
      PTR.ux /= n;
      PTR.uy /= n;
    }
    PTR.ph += PTR.kw * (0.5 * PTR.U + 0.06) * dtf;
  }

  /* ---- the figure: set in Zodiak with a contrast-matched multiplication sign; its particles condense out of the
     current on load, and dissolve, scatter and spring back under the pointer. The end state is always crisp type. ---- */
  type Mode = "intro" | "solid" | "loose" | "reform";
  const FIG = {
    mode: "intro" as Mode,
    n: 0,
    fs: 0,
    pad: 0,
    asc: 0,
    box: null as Rect | null,
    zone: null as Rect | null,
    X: new Float32Array(0),
    Y: new Float32Array(0),
    VX: new Float32Array(0),
    VY: new Float32Array(0),
    TX: new Float32Array(0),
    TY: new Float32Array(0),
    PX: new Float32Array(0),
    PY: new Float32Array(0),
    CR: new Float32Array(0),
    CG: new Float32Array(0),
    CB: new Float32Array(0),
    C0: null as Float32Array | null,
    revealT: 1e9,
    alpha: 0,
    act: 0,
    inside: false,
    t0: 0,
    boost: 1,
    R: 80,
    F: 2.3,
    ks: 0.02,
    damp: 0.86,
  };
  function figDraw(
    ctx: CanvasRenderingContext2D,
    fs: number,
    pad: number,
    asc: number,
    fill: string | CanvasGradient,
  ) {
    ctx.font = `400 ${fs}px Zodiak, Georgia, serif`;
    ctx.textBaseline = "alphabetic";
    const base = pad + asc;
    const w = ctx.measureText(figText).width;
    ctx.fillStyle = fill;
    ctx.fillText(figText, pad, base);
    // multiplication sign drawn to match Zodiak's contrast: thick stroke falls left to right, hairline rises
    const xh = fs * 0.36;
    const cx = pad + w + fs * 0.07 + xh / 2;
    const cy = base - fs * 0.27;
    const h = xh / 2;
    ctx.save();
    ctx.lineCap = "butt";
    ctx.strokeStyle = fill;
    ctx.lineWidth = fs * 0.074;
    ctx.beginPath();
    ctx.moveTo(cx - h, cy - h);
    ctx.lineTo(cx + h, cy + h);
    ctx.stroke();
    ctx.lineWidth = fs * 0.026;
    ctx.beginPath();
    ctx.moveTo(cx + h, cy - h);
    ctx.lineTo(cx - h, cy + h);
    ctx.stroke();
    ctx.restore();
  }
  function goldAt(t: number): RGB {
    for (let i = 1; i < GOLDRGB.length; i++) {
      const [p1, c1] = GOLDRGB[i] as [number, RGB];
      const [p0, c0] = GOLDRGB[i - 1] as [number, RGB];
      if (t <= p1) {
        const u = clamp((t - p0) / (p1 - p0), 0, 1);
        return [0, 1, 2].map((c) => ((c0[c] as number) * (1 - u) + (c1[c] as number) * u) / 255) as RGB;
      }
    }
    return (GOLDRGB[GOLDRGB.length - 1] as [number, RGB])[1].map((c) => c / 255) as RGB;
  }
  function figSetup(count: number, edgeShare: number) {
    const cv = el.num;
    FIG.n = 0;
    FIG.zone = null;
    if (!cv || !hasFig) return;
    const fs = G.vertical
      ? Math.round(Math.min(104, G.W * 0.27))
      : Math.round(clamp(Math.min(G.H * 0.23, G.W * 0.14), 120, 220));
    const m = document.createElement("canvas").getContext("2d");
    if (!m) return;
    m.font = `400 ${fs}px Zodiak, Georgia, serif`;
    const tm = m.measureText(figText);
    const asc = Math.ceil(tm.actualBoundingBoxAscent || fs * 0.7);
    const desc = Math.ceil(tm.actualBoundingBoxDescent || fs * 0.02);
    const pad = Math.round(fs * 0.1);
    const cw = Math.ceil(tm.width + fs * 0.07 + fs * 0.36 + pad * 2);
    const ch = asc + desc + pad * 2;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.style.width = `${cw}px`;
    cv.style.height = `${ch}px`;
    cv.style.margin = G.vertical
      ? `${-pad}px 0 ${-pad + 4}px ${-pad}px`
      : `${-pad}px ${-pad}px ${-pad + 6}px 0`;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const gr = ctx.createLinearGradient(0, pad, 0, pad + asc);
    for (const [p, h] of GOLD) gr.addColorStop(p, h);
    ctx.shadowColor = "rgba(212,171,35,0.32)";
    ctx.shadowBlur = fs * 0.09;
    figDraw(ctx, fs, pad, asc, gr);
    ctx.shadowBlur = 0;
    figDraw(ctx, fs, pad, asc, gr);
    sea.setAttribute("data-figure", "");
    // targets: the same drawing at 2x; outline first, then a sparser fill
    const sc = 2;
    const oc = document.createElement("canvas");
    oc.width = cw * sc;
    oc.height = ch * sc;
    const ox = oc.getContext("2d", { willReadFrequently: true });
    if (!ox) return;
    ox.setTransform(sc, 0, 0, sc, 0, 0);
    figDraw(ox, fs, pad, asc, "#fff");
    const id = ox.getImageData(0, 0, oc.width, oc.height).data;
    const Wo = oc.width;
    const Ho = oc.height;
    const A = (x: number, y: number) =>
      x < 0 || y < 0 || x >= Wo || y >= Ho ? 0 : (id[(y * Wo + x) * 4 + 3] as number);
    const edge: number[] = [];
    const fill: number[] = [];
    for (let y = 1; y < Ho - 1; y++)
      for (let x = 1; x < Wo - 1; x++) {
        if (A(x, y) < 128) continue;
        if (A(x - 2, y) < 128 || A(x + 2, y) < 128 || A(x, y - 2) < 128 || A(x, y + 2) < 128)
          edge.push(x / sc, y / sc);
        else if (x % 3 === 0 && y % 3 === 0) fill.push(x / sc, y / sc);
      }
    const b = cv.getBoundingClientRect();
    const sr = sea.getBoundingClientRect();
    const x0 = b.left - sr.left;
    const y0 = b.top - sr.top;
    const ne = Math.min(edge.length / 2, Math.round(count * edgeShare));
    const nf = Math.min(fill.length / 2, count - ne);
    const T: number[] = [];
    const pick = (arr: number[], k: number) => {
      const m2 = arr.length / 2;
      for (let i = 0; i < k; i++) {
        const q = Math.floor(((i + Math.random()) * m2) / k);
        T.push(x0 + (arr[q * 2] as number), y0 + (arr[q * 2 + 1] as number));
      }
    };
    pick(edge, ne);
    pick(fill, nf);
    const n = T.length / 2;
    FIG.fs = fs;
    FIG.pad = pad;
    FIG.asc = asc;
    FIG.n = n;
    FIG.box = { x0, y0, x1: x0 + cw, y1: y0 + ch };
    FIG.zone = { x0: x0 + pad * 0.4, y0: y0 + pad * 0.4, x1: x0 + cw - pad * 0.4, y1: y0 + ch - pad * 0.2 };
    FIG.R = fs * 0.36;
    FIG.F = G.vertical ? 1.7 : 2.3;
    for (const k of ["X", "Y", "VX", "VY", "TX", "TY", "PX", "PY", "CR", "CG", "CB"] as const)
      FIG[k] = new Float32Array(n);
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    for (let i = 0; i < n; i++) {
      const k = order[i] as number;
      const tx = T[k * 2] as number;
      const ty = T[k * 2 + 1] as number;
      FIG.TX[i] = FIG.X[i] = FIG.PX[i] = tx;
      FIG.TY[i] = FIG.Y[i] = FIG.PY[i] = ty;
      const c = goldAt((ty - y0 - pad) / asc);
      FIG.CR[i] = c[0];
      FIG.CG[i] = c[1];
      FIG.CB[i] = c[2];
    }
  }
  function glyph(on: boolean, dur: number, blur: number) {
    const cv = el.num;
    if (!cv) return;
    cv.style.setProperty("--nb", `${blur}px`);
    const e = "cubic-bezier(.2,.7,.2,1)";
    cv.style.transition = `opacity ${dur}s ${e},filter ${dur * 1.1}s ${e},transform ${dur * 1.2}s ${e}`;
    cv.toggleAttribute("data-on", on);
  }
  function figPoke(now: number) {
    if (reduce || !FIG.n) return;
    if (FIG.mode === "solid") {
      for (let i = 0; i < FIG.n; i++) {
        FIG.X[i] = FIG.PX[i] = f32(FIG.TX, i);
        FIG.Y[i] = FIG.PY[i] = f32(FIG.TY, i);
        FIG.VX[i] = FIG.VY[i] = 0;
      }
      FIG.t0 = now;
    }
    if (FIG.mode === "solid" || FIG.mode === "reform") {
      FIG.mode = "loose";
      FIG.alpha = 1;
      glyph(false, 0.18, 3);
    }
  }

  /* ---- frame: week axis, session ticks, the live now-line, hover readout ---- */
  const ext = { a: (si: number) => f32(geo.WA, si) * 1.25, b: (si: number) => f32(geo.WB, si) * 1.25 };
  function drawUI() {
    const d = Math.min(2, window.devicePixelRatio || 1);
    uiCv.width = Math.round(G.W * d);
    uiCv.height = Math.round(G.H * d);
    const x = uiCv.getContext("2d");
    if (!x) return;
    x.setTransform(d, 0, 0, d, 0, 0);
    x.clearRect(0, 0, G.W, G.H);
    x.font = "400 10.5px 'Azeret Mono', ui-monospace, monospace";
    x.lineWidth = 1;
    const V = G.vertical;
    for (let day = 0; day <= 7; day++) {
      const s = Math.round(sOf(day * 24)) + 0.5;
      if (s > G.S - 1) continue;
      if (day > 0) {
        x.strokeStyle = "rgba(141,166,170,.5)";
        x.beginPath();
        if (V) {
          x.moveTo(G.W - 9, s);
          x.lineTo(G.W, s);
        } else {
          x.moveTo(s, G.H - 14);
          x.lineTo(s, G.H);
        }
        x.stroke();
      }
      if (day < 7) {
        const lab = DAYS[day] as string;
        x.fillStyle = "rgba(141,166,170,.9)";
        x.lineJoin = "round";
        x.lineWidth = 4;
        x.strokeStyle = "rgba(5,12,16,.85)";
        x.textAlign = V ? "right" : "left";
        const [lx, ly] = V ? [G.W - 12, s + 13] : [s + 6, G.H - 5];
        x.strokeText(lab, lx, ly);
        x.fillText(lab, lx, ly);
        x.lineWidth = 1;
      }
    }
    x.strokeStyle = "rgba(141,166,170,.32)";
    for (let day = 1; day <= 5; day++)
      for (const t of [9.5, 16]) {
        const s = Math.round(sOf(day * 24 + t)) + 0.5;
        x.beginPath();
        if (V) {
          x.moveTo(G.W - 4, s);
          x.lineTo(G.W, s);
        } else {
          x.moveTo(s, G.H - 6);
          x.lineTo(s, G.H);
        }
        x.stroke();
      }
    // now: the live line in Bitget teal, across the current
    const now = nowET();
    const si = Math.round(clamp(sOf(now), 1, G.S - 1));
    const c = f32(geo.C, si);
    const a = Math.max(V ? 6 : G.R.hdr.y1 + 22, c - ext.a(si) - 14);
    const b = Math.min(V ? G.W - 30 : G.H - 24, c + ext.b(si) + 14);
    const s = si + 0.5;
    x.strokeStyle = LIVE;
    x.globalAlpha = 0.95;
    x.beginPath();
    if (V) {
      x.moveTo(a, s);
      x.lineTo(b, s);
    } else {
      x.moveTo(s, a);
      x.lineTo(s, b);
    }
    x.stroke();
    x.globalAlpha = 1;
    x.fillStyle = LIVE;
    x.font = "500 10.5px 'Azeret Mono', ui-monospace, monospace";
    x.lineJoin = "round";
    x.lineWidth = 4;
    x.strokeStyle = "rgba(5,12,16,.85)";
    const lab = `now, ${clock(now)} ET`;
    if (V) {
      x.textAlign = "right";
      const lx = Math.max(a - 6, x.measureText(lab).width + 4);
      x.strokeText(lab, lx, s + 4);
      x.fillText(lab, lx, s + 4);
    } else {
      x.textAlign = "center";
      x.strokeText(lab, s, a - 7);
      x.fillText(lab, s, a - 7);
    }
  }
  let probeLast = -1;
  function probeMove(x: number, y: number) {
    const s = G.vertical ? y : x;
    const hb = Math.floor(hOf(clamp(s, 0, G.S - 0.01)));
    const si = Math.round(clamp(sOf(hb + 0.5), 0, G.S));
    const c = f32(geo.C, si);
    const a = c - ext.a(si) - 10;
    const b = c + ext.b(si) + 10;
    const sl = sOf(hb + 0.5);
    el.probeLn.style.transform = G.vertical
      ? `translate(${a}px,${sl}px) scale(${b - a},1)`
      : `translate(${sl}px,${a}px) scale(1,${b - a})`;
    if (hb !== probeLast) {
      probeLast = hb;
      const w = wrap(hb);
      const head = document.createElement("b");
      head.textContent = `${fmtUsd(volAt(hb))} USDT per hour`;
      const tail = document.createElement("i");
      tail.textContent = `${data.weeks ? `median of ${data.weeks} weeks` : "hourly median"}, range ${rngAt(hb).toFixed(0)} bp`;
      el.probeLb.replaceChildren(
        head,
        `${DAYS[Math.floor(w / 24)]} ${String(w % 24).padStart(2, "0")}:00 ET, ${sessionOf(hb + 0.5)}`,
        document.createElement("br"),
        tail,
      );
    }
    // placed without reading layout (no forced reflow on a long page): flip by the label's typical size
    const gap = PTR.a * 0.8 + 12;
    const flip = x + gap + 250 > G.W - 12;
    const below = y - gap * 0.7 - 56 < G.R.hdr.y1;
    el.probeLb.style.transform = `translate(${flip ? x - gap : x + gap}px,${below ? y + gap : y - gap * 0.7}px) translate(${flip ? "-100%" : "0"},${below ? "0" : "-100%"})`;
    el.probe.setAttribute("data-on", "");
  }
  const probeHide = () => el.probe.removeAttribute("data-on");
  const inRect = (x: number, y: number, b: Rect, p: number) =>
    x >= b.x0 - p && x <= b.x1 + p && y >= b.y0 - p && y <= b.y1 + p;

  /* ---- particles ---- */
  let trails: Trails | null = null;
  let N = 0;
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let ag = new Float32Array(0);
  let lf = new Float32Array(0);
  let idata = new Float32Array(0);
  let KLUT = new Float32Array(1024);
  let wSpan = 1;
  // adaptive budget: particles currently stepped and drawn, the engine's smoothed frame cost, light per particle
  let Nact = 0;
  let costEma = 0;
  let lumen = 1;
  const hardIsland = (x: number, y: number) => {
    const b = G.R.claim;
    return x > b.x0 - 18 && x < b.x1 + 18 && y > b.y0 - 18 && y < b.y1 + 18;
  };
  function spawn(i: number) {
    let x = 0;
    let y = 0;
    for (let t = 0; t < 6; t++) {
      const r = Math.random();
      if (r < 0.36) {
        x = Math.random() * G.W;
        y = Math.random() * G.H;
      } else {
        // along the week, weighted towards wide water; across it, the core (gaussian) or the shoulder
        let s = Math.random() * G.S;
        for (let q = 0; q < 3; q++) {
          const si = Math.round(s);
          if (Math.random() < 0.3 + (0.7 * (f32(geo.WA, si) + f32(geo.WB, si))) / wSpan) break;
          s = Math.random() * G.S;
        }
        const si = Math.round(s);
        const z = r < 0.54 ? (Math.random() < 0.5 ? -1 : 1) * (1.05 + Math.random() * 2.3) : gauss() * 0.9;
        [x, y] = toXY(s, f32(geo.C, si) + z * (z < 0 ? f32(geo.WA, si) : f32(geo.WB, si)));
      }
      if (!hardIsland(x, y)) break;
    }
    px[i] = x;
    py[i] = y;
    ag[i] = 0;
    lf[i] = 80 + Math.random() * 190;
  }
  function makeTrails(): Trails | null {
    const t = createTrailsGL(flowCv, BG, onLost, onRestored, CAP?.fade);
    if (t) return t;
    // a WebGL2 context may exist but be unusable: the 2D fallback needs a fresh canvas
    const fresh = mkCanvas();
    flowCv.replaceWith(fresh);
    flowCv = fresh;
    return createTrails2D(flowCv);
  }
  function initEngine() {
    if (!trails) trails = makeTrails();
    if (!trails) return;
    const UMAX = G.vertical ? 2.6 : 3.4;
    KLUT = new Float32Array(1024);
    for (let q = 0; q < 1024; q++) KLUT[q] = clamp((q / 64 - 0.06) / UMAX, 0, 1) ** (1 / 2.3);
    const area = G.W * G.H;
    let scale = Math.min(2, window.devicePixelRatio || 1);
    if (area * scale * scale > 3.4e6) scale = Math.sqrt(3.4e6 / area);
    trails.resize(G.W, G.H, scale);
    const R = G.R;
    // the headline sits on dark water; the sub, CTA, caption, legend and header on a dimmed fringe; the figure open
    const mask: MaskRect[] = [
      { b: R.claim, a: 1, p: 16 },
      { b: R.rest, a: 0.42, p: 12 },
      { b: R.cap, a: 0.8, p: 12 },
      { b: R.legend, a: 0.5, p: 10 },
      { b: { x0: 0, y0: 0, x1: G.W, y1: R.hdr.y1 - 14 }, a: 0.35, p: 0 },
    ];
    trails.setMask(mask);
    F = buildField();
    wSpan = 1;
    for (let s = 0; s <= G.S; s++) wSpan = Math.max(wSpan, f32(geo.WA, s) + f32(geo.WB, s));
    const hiDpr = (window.devicePixelRatio || 1) > 1.5;
    N = Math.round(
      clamp(area / (G.vertical ? 92 : 118), 3000, 12000) * (hiDpr ? 0.85 : 1) * (trails.webgl ? 1 : 0.35),
    );
    px = new Float32Array(N);
    py = new Float32Array(N);
    ag = new Float32Array(N);
    lf = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      spawn(i);
      ag[i] = Math.random() * f32(lf, i);
    }
    idata = new Float32Array((N + FIG.n) * STRIDE);
    Nact = N;
    costEma = 0;
    lumen = 1;
    PTR.a = G.vertical ? 24 : clamp(Math.min(G.W, G.H) * 0.04, 26, 44);
    PTR.reach = PTR.a * 7.2;
    PTR.wakeL = PTR.a * 6.5;
    PTR.kw = (2 * Math.PI) / (2.3 * PTR.a);
  }
  function stepFlow(dtf: number) {
    const stickOn = PTR.k >= 0.004;
    const W = G.W;
    const H = G.H;
    const D = idata;
    const n = Nact;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const x = f32(px, i);
      const y = f32(py, i);
      let v = sampleV(x, y);
      if (stickOn) stick(x, y, v);
      const mx = x + f32(v, 0) * dtf * 0.5;
      const my = y + f32(v, 1) * dtf * 0.5;
      v = sampleV(mx, my);
      if (stickOn) stick(mx, my, v);
      const vx = f32(v, 0);
      const vy = f32(v, 1);
      const nx = x + vx * dtf;
      const ny = y + vy * dtf;
      const age = f32(ag, i) + dtf;
      ag[i] = age;
      const life = f32(lf, i);
      if (age > life || nx < -8 || ny < -8 || nx > W + 8 || ny > H + 8) {
        spawn(i);
        D[o + 7] = 0;
        D[o] = D[o + 2] = f32(px, i);
        D[o + 1] = D[o + 3] = f32(py, i);
        continue;
      }
      D[o] = x;
      D[o + 1] = y;
      D[o + 2] = nx;
      D[o + 3] = ny;
      let q = (Math.sqrt(vx * vx + vy * vy) * 64) | 0;
      if (q > 1023) q = 1023;
      const k = f32(KLUT, q);
      const li = ((k * 255 + 0.5) | 0) * 3;
      D[o + 4] = f32(TLUT, li);
      D[o + 5] = f32(TLUT, li + 1);
      D[o + 6] = f32(TLUT, li + 2);
      const fio = Math.min(1, age / 14, (life - age) / 28);
      D[o + 7] = (0.13 + 0.42 * k * k) * lumen * fio * dimAt(nx, ny);
      D[o + 8] = 0.6 + 0.4 * k;
      px[i] = nx;
      py[i] = ny;
    }
  }
  /* intro: particles peel off the current downstream of their own position and settle onto the figure */
  function stepIntro(t: number) {
    const v = G.vertical;
    const n = FIG.n;
    if (!FIG.C0) {
      const C0 = new Float32Array(n * 10);
      FIG.C0 = C0;
      const pool: number[] = [];
      const box = FIG.box as Rect;
      const sA = v ? box.y0 - 30 : G.W * 0.44;
      const sB = v ? G.R.cap.y1 + 40 : Math.min(G.R.cap.x0 - 10, G.W * 0.78);
      for (let i = 0; i < N; i++) {
        const [s, nn] = toSN(f32(px, i), f32(py, i));
        if (s < sA || s > sB) continue;
        const si = Math.round(s);
        const d = nn - f32(geo.C, si);
        const w = d < 0 ? f32(geo.WA, si) : f32(geo.WB, si);
        if (Math.abs(d) < w * 1.1) pool.push(i);
      }
      for (let j = 0; j < n; j++) {
        const i = pool.length ? (pool[(Math.random() * pool.length) | 0] as number) : (Math.random() * N) | 0;
        const o = j * 10;
        const x = f32(px, i);
        const y = f32(py, i);
        const tx = f32(FIG.TX, j);
        const ty = f32(FIG.TY, j);
        const f = sampleV(x, y);
        const sp = Math.hypot(f32(f, 0), f32(f, 1)) || 1;
        const dx = f32(f, 0) / sp;
        const dy = f32(f, 1) / sp;
        C0[o] = x;
        C0[o + 1] = y;
        if (!v) {
          C0[o + 2] = x + dx * 60;
          C0[o + 3] = y + dy * 20 - (y - ty) * 0.5 + gauss() * 8;
          C0[o + 4] = tx - 90 - Math.random() * 130;
          C0[o + 5] = ty + (Math.random() - 0.5) * 26;
        } else {
          C0[o + 2] = x + dx * 16 - 26;
          C0[o + 3] = y + dy * 36 - 18;
          C0[o + 4] = tx + 70 + Math.random() * 80;
          C0[o + 5] = ty + (Math.random() - 0.5) * 18;
        }
        C0[o + 6] = Math.random() ** 0.8 * 0.95;
        C0[o + 7] = 1.45 + Math.random() * 0.6;
        C0[o + 8] = Math.random() * 6.283;
        FIG.X[j] = FIG.PX[j] = x;
        FIG.Y[j] = FIG.PY[j] = y;
      }
      FIG.revealT = COND_T0 + 0.62 + 1.75;
    }
    const C0 = FIG.C0;
    for (let j = 0; j < n; j++) {
      const o = j * 10;
      const q = clamp((t - COND_T0 - f32(C0, o + 6)) / f32(C0, o + 7), 0, 1);
      let x: number;
      let y: number;
      FIG.PX[j] = f32(FIG.X, j);
      FIG.PY[j] = f32(FIG.Y, j);
      if (q <= 0) {
        x = f32(C0, o);
        y = f32(C0, o + 1);
        FIG.PX[j] = x;
        FIG.PY[j] = y;
      } else if (q < 1) {
        const io = q < 0.5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2;
        const e = 0.22 * q + 0.78 * io;
        const u = 1 - e;
        const a = u * u * u;
        const b = 3 * u * u * e;
        const c = 3 * u * e * e;
        const d = e * e * e;
        x = a * f32(C0, o) + b * f32(C0, o + 2) + c * f32(C0, o + 4) + d * f32(FIG.TX, j);
        y = a * f32(C0, o + 1) + b * f32(C0, o + 3) + c * f32(C0, o + 5) + d * f32(FIG.TY, j);
      } else {
        const ph = f32(C0, o + 8);
        x = f32(FIG.TX, j) + Math.cos(t * 2.7 + ph) * 0.5;
        y = f32(FIG.TY, j) + Math.sin(t * 2.3 + ph) * 0.5;
      }
      FIG.X[j] = x;
      FIG.Y[j] = y;
    }
    const fadeOut = clamp(1 - (t - FIG.revealT - 0.15) / 0.9, 0, 1);
    FIG.alpha = fadeOut;
    if (t >= FIG.revealT && !el.num?.hasAttribute("data-on")) glyph(true, 1, 10);
    if (fadeOut <= 0) {
      FIG.mode = "solid";
      for (let j = 0; j < n; j++) {
        FIG.X[j] = FIG.PX[j] = f32(FIG.TX, j);
        FIG.Y[j] = FIG.PY[j] = f32(FIG.TY, j);
        FIG.VX[j] = FIG.VY[j] = 0;
      }
    }
  }
  /* loose: springs to the glyph targets, damped; the pointer pushes them away while it moves */
  function stepLoose(dtf: number, now: number) {
    const moving = FIG.inside && now - PTR.last < 110;
    FIG.act += ((moving ? 1 : 0) - FIG.act) * Math.min(1, (moving ? 0.35 : 0.1) * dtf);
    const { n, X, Y, VX, VY, TX, TY, R } = FIG;
    const R2 = R * R;
    const f0 = FIG.F * FIG.act;
    const qx = PTR.tx;
    const qy = PTR.ty;
    const pvx = PTR.vx * 0.22 * FIG.act;
    const pvy = PTR.vy * 0.22 * FIG.act;
    const damp = FIG.damp ** dtf;
    const ks = FIG.ks * dtf;
    let maxD = 0;
    let maxV = 0;
    for (let j = 0; j < n; j++) {
      let x = f32(X, j);
      let y = f32(Y, j);
      let vx = f32(VX, j);
      let vy = f32(VY, j);
      if (f0 > 0.01) {
        const dx = x - qx;
        const dy = y - qy;
        const d2 = dx * dx + dy * dy;
        if (d2 < R2) {
          const d = Math.sqrt(d2) || 0.01;
          const u = 1 - d / R;
          const f = f0 * u * u;
          vx += ((dx / d) * f + pvx * u) * dtf;
          vy += ((dy / d) * f + pvy * u) * dtf;
        }
      }
      const tx = f32(TX, j);
      const ty = f32(TY, j);
      vx = (vx + (tx - x) * ks) * damp;
      vy = (vy + (ty - y) * ks) * damp;
      FIG.PX[j] = x;
      FIG.PY[j] = y;
      x += vx * dtf;
      y += vy * dtf;
      X[j] = x;
      Y[j] = y;
      VX[j] = vx;
      VY[j] = vy;
      maxD = Math.max(maxD, Math.abs(x - tx) + Math.abs(y - ty));
      maxV = Math.max(maxV, Math.abs(vx) + Math.abs(vy));
    }
    const settled = maxD < 1.4 && maxV < 0.12;
    const still = !FIG.inside || now - PTR.last > 600;
    if (FIG.mode === "loose" && settled && still && now - FIG.t0 > 350) {
      FIG.mode = "reform";
      glyph(true, 0.5, 4);
    }
    if (FIG.mode === "reform") {
      FIG.alpha = Math.max(0, FIG.alpha - dtf / 30);
      if (FIG.alpha <= 0) FIG.mode = "solid";
    }
    FIG.boost = 1 + 6 * Math.max(0, 1 - (now - FIG.t0) / 140);
  }
  function writeFig(intro: boolean) {
    const base = Nact * STRIDE;
    const D = idata;
    for (let j = 0; j < FIG.n; j++) {
      const w = base + j * STRIDE;
      const x0 = f32(FIG.PX, j);
      const y0 = f32(FIG.PY, j);
      const x1 = f32(FIG.X, j);
      const y1 = f32(FIG.Y, j);
      D[w] = x0;
      D[w + 1] = y0;
      D[w + 2] = x1;
      D[w + 3] = y1;
      D[w + 4] = f32(FIG.CR, j);
      D[w + 5] = f32(FIG.CG, j);
      D[w + 6] = f32(FIG.CB, j);
      const sp = Math.abs(x1 - x0) + Math.abs(y1 - y0);
      D[w + 7] = intro
        ? (sp > 1.5 ? 0.34 : 0.16) * FIG.alpha
        : FIG.alpha * Math.min(1, (0.07 + 0.5 * Math.min(1, sp / 2.2)) * FIG.boost);
      D[w + 8] = intro ? (sp > 1.5 ? 0.8 : 1.2) : 1.05;
    }
  }
  function frame(t: number, dt: number, now: number) {
    if (!trails) return;
    const dtf = clamp(dt / 16.667, 0.3, 2.2);
    stickFrame(dtf);
    stepFlow(CAP ? dtf * CAP.speed : dtf);
    let count = Nact;
    if (FIG.n && FIG.mode === "intro" && t >= COND_T0) {
      stepIntro(t);
      writeFig(true);
      count = Nact + FIG.n;
    } else if (FIG.mode === "loose" || FIG.mode === "reform") {
      stepLoose(dtf, now);
      writeFig(false);
      count = Nact + FIG.n;
    }
    trails.draw(idata, count);
  }
  /* the same physics integrated for ~4.5 s at once: a long-exposure plate of the current */
  function still() {
    if (!trails) return;
    for (let k = 0; k < 280; k++) {
      stepFlow(1);
      trails.draw(idata, N, k === 279);
    }
  }

  /* ---- runtime: pause off-screen and in hidden tabs, rebuild on a real resize, honour reduced motion ---- */
  let raf = 0;
  let t0 = 0;
  let last = 0;
  let running = false;
  let inView = true;
  let disposed = false;
  let lost = false;
  let ready = false;
  function start() {
    pause();
    if (disposed) return;
    G = readLayout();
    figSetup(G.vertical ? 1100 : 2200, 0.56);
    G = readLayout(); // after the figure canvas is sized: the real caption block
    geo = buildGeometry(cfgFor());
    FIG.C0 = null;
    FIG.alpha = 0;
    FIG.act = 0;
    initEngine();
    if (!trails) return;
    drawUI();
    ready = true;
    sea.setAttribute("data-flow", trails.webgl ? "webgl" : "2d");
    if (reduce || !FIG.n) {
      FIG.mode = "solid";
      if (FIG.n) glyph(true, 0, 0);
    } else {
      FIG.mode = "intro";
      el.num?.removeAttribute("data-on");
    }
    if (reduce) {
      still();
      return;
    }
    t0 = performance.now();
    last = t0;
    resume();
  }
  function loop(now: number) {
    if (!running) return;
    const dt = CAP ? 1000 / 60 : Math.min(50, Math.max(4, now - last));
    last = now;
    if (pend) {
      pointerAt(pend[0], pend[1]);
      pend = null;
    }
    const a = performance.now();
    frame((now - t0) / 1000, dt, now);
    if (!CAP) govern(performance.now() - a);
    raf = requestAnimationFrame(loop);
  }
  /* a slow main thread sheds particles (down to half) instead of frames, and each remaining particle carries a
     little more light so the current keeps its brightness; they come back when there is headroom */
  function govern(cost: number) {
    costEma = costEma ? costEma * 0.92 + cost * 0.08 : cost;
    const floor = Math.round(N * 0.5);
    if (costEma > 8 && Nact > floor) Nact = Math.max(floor, Math.round(Nact * 0.97));
    else if (costEma < 5 && Nact < N) Nact = Math.min(N, Math.round(Nact * 1.01) + 1);
    lumen = Math.min(1.35, Math.sqrt(N / Math.max(1, Nact)));
  }
  function pause() {
    running = false;
    cancelAnimationFrame(raf);
  }
  function resume() {
    if (reduce || running || !ready || disposed || lost || document.hidden || !inView) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function onLost() {
    lost = true;
    pause();
  }
  function onRestored() {
    lost = false;
    start();
  }
  function pointerAt(x: number, y: number) {
    if (!ready) return;
    PTR.tx = x;
    PTR.ty = y;
    PTR.last = performance.now();
    FIG.inside = !!FIG.zone && FIG.mode !== "intro" && inRect(x, y, FIG.zone, 0);
    if (FIG.inside) {
      PTR.on = false;
      probeHide();
      figPoke(PTR.last);
      return;
    }
    for (const b of G.probeBlocks)
      if (inRect(x, y, b, 6)) {
        PTR.on = false;
        probeHide();
        return;
      }
    PTR.on = !reduce;
    probeMove(x, y);
  }
  function pointerOff() {
    PTR.on = false;
    FIG.inside = false;
    probeHide();
  }
  let seaRect: DOMRect | null = null;
  const local = (cx: number, cy: number): [number, number] => {
    seaRect ??= sea.getBoundingClientRect();
    return [cx - seaRect.left, cy - seaRect.top];
  };
  const onScroll = () => {
    seaRect = null;
  };
  // pointer input is applied once per frame (coalesced), or at once when nothing is animating
  let pend: [number, number] | null = null;
  const queue = (p: [number, number]) => {
    if (running) pend = p;
    else pointerAt(p[0], p[1]);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    queue(local(e.clientX, e.clientY));
  };
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType !== "touch") {
      pend = null;
      pointerOff();
    }
  };
  // touch: follow the finger while it is down, including while the page scrolls under it (touch-action: pan-y)
  const onTouch = (e: TouchEvent) => {
    const t = e.touches[0];
    if (t) queue(local(t.clientX, t.clientY));
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (!e.touches.length) {
      pend = null;
      pointerOff();
    }
  };
  const onVisibility = () => (document.hidden ? pause() : resume());
  let rsz: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => {
      // phones fire resize when the address bar slides: rebuild only on a real layout change
      if (ready && Math.abs(sea.clientWidth - G.W) < 2 && Math.abs(sea.clientHeight - G.H) < 120) return;
      start();
    }, 180);
    seaRect = null;
  };
  const io =
    "IntersectionObserver" in window
      ? new IntersectionObserver((es) => {
          inView = es.some((e) => e.isIntersecting);
          if (inView) resume();
          else pause();
        })
      : null;

  sea.addEventListener("pointermove", onPointerMove);
  sea.addEventListener("pointerleave", onPointerLeave);
  sea.addEventListener("touchstart", onTouch, { passive: true });
  sea.addEventListener("touchmove", onTouch, { passive: true });
  sea.addEventListener("touchend", onTouchEnd);
  sea.addEventListener("touchcancel", onTouchEnd);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onScroll, { passive: true });
  io?.observe(sea);
  start();

  return () => {
    disposed = true;
    pause();
    clearTimeout(rsz);
    io?.disconnect();
    sea.removeEventListener("pointermove", onPointerMove);
    sea.removeEventListener("pointerleave", onPointerLeave);
    sea.removeEventListener("touchstart", onTouch);
    sea.removeEventListener("touchmove", onTouch);
    sea.removeEventListener("touchend", onTouchEnd);
    sea.removeEventListener("touchcancel", onTouchEnd);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("scroll", onScroll);
    trails?.dispose();
    trails = null;
    flowCv.remove();
    uiCv.remove();
    sea.removeAttribute("data-flow");
    sea.removeAttribute("data-figure");
    probeHide();
  };
}
