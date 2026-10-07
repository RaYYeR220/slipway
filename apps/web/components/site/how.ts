// Hour-of-week traded value from Bitget's public 1h candles, built by app/atlas/_data/hour-of-week.mjs into
// public/data/hour-of-week.json (static, dated, re-runnable). Index 0 = Sunday 00:00 New York.
import raw from "@/public/data/hour-of-week.json";

export interface HowSeries {
  symbol: string;
  hours: number;
  from: number;
  to: number;
  vol: (number | null)[];
  rng: (number | null)[];
  weeks: number[];
}

export interface HowDoc {
  generatedAt: string;
  source: { endpoint: string; params: string; value: string; statistic: string };
  from: number;
  to: number;
  series: Record<string, { rtoken: HowSeries | null; perp: HowSeries | null }>;
}

export const HOW = raw as unknown as HowDoc;

export const HOW_PUBLIC_PATH = "/data/hour-of-week.json";

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? (a[m] as number) : ((a[m - 1] as number) + (a[m] as number)) / 2;
};

/** Median of Mon–Fri hours [h0, h1) New York time. */
export function weekdayMedian(vol: (number | null)[], h0: number, h1: number): number | null {
  const xs: number[] = [];
  for (let d = 1; d <= 5; d++)
    for (let h = h0; h < h1; h++) {
      const v = vol[d * 24 + h];
      if (typeof v === "number") xs.push(v);
    }
  return median(xs);
}

/** Weekend = Fri 20:00 → Sun 20:00 New York. */
export function isWeekendHour(i: number): boolean {
  const d = Math.floor(i / 24);
  const h = i % 24;
  return (d === 5 && h >= 20) || d === 6 || (d === 0 && h < 20);
}

export function weekendRange(vol: (number | null)[]): { min: number; max: number } | null {
  const xs = vol.filter((v, i): v is number => typeof v === "number" && isWeekendHour(i));
  return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};

export function howSourceLine(s: HowSeries): string {
  return `${s.symbol} 1h candles, Bitget public API, ${shortDate(s.from)} – ${shortDate(s.to)} ${new Date(s.to).getUTCFullYear()}, median per New York hour-of-week`;
}
