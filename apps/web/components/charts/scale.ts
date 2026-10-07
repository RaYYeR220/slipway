// Small scale helpers for hand-written SVG charts.

export function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  const step = niceStep(hi - lo, target);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Acklam's rational approximation of the standard normal quantile. */
export function invNorm(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q0 = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  const pl = 0.02425;
  const A = a as [number, number, number, number, number, number];
  const B = b as [number, number, number, number, number];
  const C = c as [number, number, number, number, number, number];
  const D = d as [number, number, number, number];
  if (q0 < pl) {
    const q = Math.sqrt(-2 * Math.log(q0));
    return (
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    );
  }
  if (q0 > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - q0));
    return (
      -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    );
  }
  const q = q0 - 0.5;
  const r = q * q;
  return (
    ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
  );
}

/** A deterministic ensemble: n stratified draws of N(mean, sd), each with a fixed vertical jitter in [-0.5, 0.5]. */
export function ensemble(mean: number, sd: number, n = 40): { v: number; j: number }[] {
  const out: { v: number; j: number }[] = [];
  for (let i = 0; i < n; i++) {
    const z = invNorm((i + 0.5) / n);
    out.push({ v: mean + sd * z, j: ((i * 0.6180339887) % 1) - 0.5 });
  }
  return out;
}
