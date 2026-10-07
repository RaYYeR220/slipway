// Tiny scale helpers for hand-written SVG charts (no chart library).

export type Scale = ((v: number) => number) & { domain: [number, number]; range: [number, number] };

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const f = ((v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0))) as Scale;
  f.domain = domain;
  f.range = range;
  return f;
}

export function log10Scale(domain: [number, number], range: [number, number]): Scale {
  const l = linear([Math.log10(domain[0]), Math.log10(domain[1])], range);
  const f = ((v: number) => l(Math.log10(Math.max(v, domain[0])))) as Scale;
  f.domain = domain;
  f.range = range;
  return f;
}

/** Round tick values covering [lo, hi] with about `count` steps (1-2-5 spacing). */
export function ticks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(12)));
  return out;
}

export function extent(xs: number[]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    if (!Number.isFinite(x)) continue;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

/** Quantised index into a 9-step (or n-step) ramp for t in [0, 1]. */
export const rampIndex = (t: number, n = 9) => Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
