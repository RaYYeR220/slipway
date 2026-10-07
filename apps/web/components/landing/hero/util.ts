// Small numeric, colour and New York clock helpers for the landing hero (flow.ts). No DOM state.

export type RGB = [number, number, number];
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const wrap = (h: number) => ((h % 168) + 168) % 168;
/** Bridson's smooth ramp, used to clamp a stream function around an island. */
export const ramp = (t: number) =>
  t >= 1 ? 1 : t <= 0 ? 0 : (15 / 8) * t - (10 / 8) * t ** 3 + (3 / 8) * t ** 5;
/** Soft minimum: a width that approaches the room it has without a flat clamp. */
export const smin = (a: number, b: number) => (a * b) / (a ** 4 + b ** 4) ** 0.25;
export const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
export const hex = (h: string): RGB => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
];

/** n-entry RGB lookup (0..1 floats) interpolated through the given stops. */
export function rampLUT(stops: RGB[], n: number): Float32Array {
  const o = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(f));
    const u = f - k;
    const a = stops[k] as RGB;
    const b = stops[k + 1] as RGB;
    for (let c = 0; c < 3; c++) o[i * 3 + c] = ((a[c] as number) * (1 - u) + (b[c] as number) * u) / 255;
  }
  return o;
}

/** Signed distance from a point to a rectangle (negative inside). */
export function sdRect(x: number, y: number, b: Rect): number {
  const dx = Math.max(b.x0 - x, 0, x - b.x1);
  const dy = Math.max(b.y0 - y, 0, y - b.y1);
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return -Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y);
}

export function minFilter(a: Float32Array, r: number) {
  const n = a.length;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 1e9;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) m = Math.min(m, a[j] as number);
    o[i] = m;
  }
  return o;
}

export function blur1(a: Float32Array, sig: number) {
  const n = a.length;
  const r = Math.ceil(sig * 2.5);
  const k: number[] = [];
  let ks = 0;
  for (let j = -r; j <= r; j++) {
    const v = Math.exp((-j * j) / (2 * sig * sig));
    k.push(v);
    ks += v;
  }
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += (a[clamp(i + j, 0, n - 1)] as number) * (k[j + r] as number);
    o[i] = acc / ks;
  }
  return o;
}

/** Seeded 2D simplex noise (deterministic, so the sea looks the same on every load). */
export function makeNoise(seed: number): (x: number, y: number) => number {
  const p = new Uint8Array(512);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j] as number, perm[i] as number];
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255] as number;
  const GX = [1, -1, 1, -1, 1, -1, 0, 0];
  const GY = [1, 1, -1, -1, 0, 0, 1, -1];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const at = (i: number) => p[i] as number;
  const corner = (g: number, x: number, y: number) => {
    let q = 0.5 - x * x - y * y;
    if (q <= 0) return 0;
    q *= q;
    return q * q * ((GX[g] as number) * x + (GY[g] as number) * y);
  };
  return (x, y) => {
    const t0 = (x + y) * F2;
    const i = Math.floor(x + t0);
    const j = Math.floor(y + t0);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const ii = i & 255;
    const jj = j & 255;
    return (
      70 *
      (corner(at(ii + at(jj)) & 7, x0, y0) +
        corner(at(ii + i1 + at(jj + j1)) & 7, x0 - i1 + G2, y0 - j1 + G2) +
        corner(at(ii + 1 + at(jj + 1)) & 7, x0 - 1 + 2 * G2, y0 - 1 + 2 * G2))
    );
  };
}

export function fmtUsd(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e8) return `${Math.round(v / 1e6)}M`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** "Tue 07:57" for an hour-of-week (index 0 = Sunday 00:00 New York). */
export function clock(h: number): string {
  const w = wrap(h);
  let d = Math.floor(w / 24);
  let hh = Math.floor(w % 24);
  let mm = Math.round((w - Math.floor(w)) * 60);
  if (mm === 60) {
    mm = 0;
    hh++;
    if (hh === 24) {
      hh = 0;
      d = (d + 1) % 7;
    }
  }
  return `${DAYS[d]} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function sessionOf(h: number): string {
  const w = wrap(h);
  const d = Math.floor(w / 24);
  const t = w % 24;
  if (d === 6 || (d === 5 && t >= 20) || (d === 0 && t < 20)) return "weekend";
  if (t >= 9.5 && t < 16) return "regular session";
  if (t >= 4 && t < 9.5) return "pre-market";
  if (t >= 16 && t < 20) return "after-hours";
  return "overnight";
}

/** The current New York hour-of-week. */
export function nowET(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const o: Record<string, string> = {};
  for (const x of parts) o[x.type] = x.value;
  const d = DAYS.indexOf((o.weekday ?? "Sun") as (typeof DAYS)[number]);
  return Math.max(0, d) * 24 + (Number(o.hour) % 24) + Number(o.minute) / 60;
}

/** log10 USDT per hour mapped to depth 0..1 (shared by the flow and the legend). */
export function depthScale(vol: readonly number[]): {
  lmin: number;
  lmax: number;
  k: (log10: number) => number;
} {
  let mx = 0;
  for (const v of vol) mx = Math.max(mx, Math.log10(Math.max(Number(v) || 0, 1)));
  const lmin = 3.2;
  const lmax = Math.max(8.4, mx - 0.22);
  return { lmin, lmax, k: (l: number) => clamp((l - lmin) / (lmax - lmin), 0, 1) };
}
