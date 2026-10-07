// Formatting for figures the canvas draws itself (all from API payloads, never from model text).
import type { Session, StrategyKind, Venue } from "./types";

const MINUS = "−";

export function num(x: number, dp = 1): string {
  const s = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return x < 0 && Number(s.replace(/,/g, "")) !== 0 ? `${MINUS}${s}` : s;
}

export function signed(x: number, dp = 1): string {
  const s = num(x, dp);
  return x > 0 && Number(Math.abs(x).toFixed(dp)) !== 0 ? `+${s}` : s;
}

export const bps = (x: number, dp = 1) => `${num(x, dp)} bp`;

export function usd(x: number, dp = 0): string {
  const s = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${x < 0 ? MINUS : ""}$${s}`;
}

/** $342k, $1.06M — for axis ticks and dense tables only. */
export function usdCompact(x: number): string {
  const a = Math.abs(x);
  const sign = x < 0 ? MINUS : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(0)}`;
}

export function qty(x: number): string {
  const dp = x >= 1000 ? 2 : 4;
  return x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

export function price(x: number): string {
  return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: x < 10 ? 4 : 2 });
}

/** 0.8 s · 42 s · 3 min · 1 h 4 min · 2 d */
export function age(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 90) return `${Math.round(s)} s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${Math.round(m - h * 60)} min`;
  return `${Math.round(h / 24)} d`;
}

const NY = "America/New_York";
const clockFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: NY,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const dayClockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const nyClock = (ts: number) => clockFmt.format(ts);
/** "Tue 06:41" in New York. */
export function nyDayTime(ts: number): string {
  return dayClockFmt.format(ts).replace(",", "");
}

const SESSION_LABEL: Record<Session, string> = {
  pre_market: "pre-market",
  regular: "regular",
  after_hours: "after-hours",
  overnight: "overnight",
  weekend: "weekend",
  closed: "closed",
};
export const sessionLabel = (s: string) => SESSION_LABEL[s as Session] ?? s.replace(/_/g, " ");

export const SESSION_SHORT: Record<Session, string> = {
  pre_market: "pre",
  regular: "regular",
  after_hours: "after",
  overnight: "overnight",
  weekend: "weekend",
  closed: "closed",
};

export const venueName = (v: Venue | string, symbol: string) =>
  v === "rtoken" ? `r${symbol}` : `${symbol} perp`;

export const FAMILY_ORDER: StrategyKind[] = [
  "immediate",
  "sliced",
  "passive",
  "wait",
  "perp_then_rotate",
  "perp_hold",
];

const FAMILY_NAME: Record<StrategyKind, string> = {
  immediate: "Immediate",
  sliced: "Sliced",
  passive: "Passive at the touch",
  wait: "Wait for a session",
  perp_then_rotate: "Perp now, rotate later",
  perp_hold: "Perp hold",
};

export const isBaselineId = (id: string) => id.startsWith("twap");

export function familyName(kind: StrategyKind | string, id?: string): string {
  if (id && isBaselineId(id)) return "TWAP baseline";
  return FAMILY_NAME[kind as StrategyKind] ?? kind;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
