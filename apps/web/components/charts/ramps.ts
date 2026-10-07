// Colour scales sampled from cmocean (Thyng et al. 2016): tempo for depth / tightness, solar for cost. The same
// stops live as CSS tokens in globals.css; canvas and gradient stops need them as numbers.
export const TEMPO = [
  "#151d44",
  "#1b3c56",
  "#1b5968",
  "#117777",
  "#2a937f",
  "#69ab89",
  "#a1c1a1",
  "#d2d9c7",
  "#fff6f4",
];
export const SOLAR = ["#331418", "#5b2023", "#822d22", "#a04519", "#b66413", "#c78616", "#d4ab23", "#ddd236"];
export const LIVE = "#26bfd4";

export type RGB = [number, number, number];
export const hexRgb = (h: string): RGB => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
];
const TEMPO_RGB = TEMPO.map(hexRgb);

function sample(stops: RGB[], u: number): RGB {
  const x = Math.max(0, Math.min(1, u)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i] as RGB;
  const b = stops[i + 1] as RGB;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Liquidity colour: k = 0 thin water, 1 deep/tight water. On the abyss (dark) the deep end is the bright end of
 * tempo; on printed-atlas paper the ramp runs forward so deep water is the darkest ink. Either way, more liquid
 * means more contrast against the page.
 */
export function waterRgb(k: number, light: boolean): RGB {
  // skip the two extreme stops: the darkest vanishes on the abyss, the lightest on paper
  return light ? sample(TEMPO_RGB.slice(1, 7).reverse(), k) : sample(TEMPO_RGB.slice(2, 8), k);
}

export const rgbCss = (c: RGB, a = 1) =>
  a >= 1
    ? `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0})`
    : `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0} / ${a.toFixed(3)})`;

/** Tightness from a quoted spread in bps: 0.25 bp → 1, 10 bp and wider → 0 (log scale). */
export const tightness = (spreadBps: number) =>
  Math.max(0, Math.min(1, 1 - Math.log(Math.max(spreadBps, 0.25) / 0.25) / Math.log(40)));

// Strategy families: a categorical palette validated for CVD separation on both surfaces (dataviz validator,
// adjacent ΔE ≥ 10). Fixed order, never cycled; always shipped with a legend and direct labels.
const FAMILY_DARK = {
  sliced: "#1f9a7e",
  passive: "#c08a12",
  immediate: "#3d8fc4",
  perp_then_rotate: "#d0573a",
  wait: "#9a6ad0",
  perp_hold: "#d0573a",
} as const;
const FAMILY_LIGHT = {
  sliced: "#17806a",
  passive: "#9a6b06",
  immediate: "#2f77a8",
  perp_then_rotate: "#b8462b",
  wait: "#7d50b6",
  perp_hold: "#b8462b",
} as const;

export function familyColor(kind: string, light: boolean): string {
  const m = light ? FAMILY_LIGHT : FAMILY_DARK;
  return (m as Record<string, string>)[kind] ?? (light ? "#5f7e85" : "#8da6aa");
}

/** Cost components: solar steps, darker = earlier in the stack. */
export const COMPONENT_COLOR: Record<"spread" | "impact" | "fees" | "funding", string> = {
  spread: SOLAR[3] as string,
  impact: SOLAR[4] as string,
  fees: SOLAR[5] as string,
  funding: SOLAR[6] as string,
};
