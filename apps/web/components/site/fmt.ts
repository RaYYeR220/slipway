// Display formatting shared by the site pages. Numbers arrive computed; these only format them.

const finite = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

export const NA = "n/a";

export function bp(x: number | null | undefined, dp = 1): string {
  return finite(x) ? `${x.toFixed(dp)} bp` : NA;
}

export function signedBp(x: number | null | undefined, dp = 1): string {
  if (!finite(x)) return NA;
  const s = x.toFixed(dp);
  return `${x > 0 && Number(s) !== 0 ? "+" : x < 0 && Number(s) !== 0 ? "−" : ""}${s.replace("-", "")} bp`;
}

export function num(x: number | null | undefined, dp = 0): string {
  return finite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : NA;
}

export function pct(x: number | null | undefined, dp = 0): string {
  return finite(x) ? `${(x * 100).toFixed(dp)}%` : NA;
}

/** $1.2k, $3.4M, $2.31B — compact money for chart labels. */
export function usd(x: number | null | undefined): string {
  if (!finite(x)) return NA;
  const a = Math.abs(x);
  const sign = x < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a)}`;
}

/** Axis ticks: $1k, $100k, $10M, $1B — no trailing zeros. */
export function usdTick(x: number): string {
  const a = Math.abs(x);
  const t = (v: number, u: string) => `$${Number(v.toPrecision(3))}${u}`;
  if (a >= 1e9) return t(x / 1e9, "B");
  if (a >= 1e6) return t(x / 1e6, "M");
  if (a >= 1e3) return t(x / 1e3, "k");
  return t(x, "");
}

export function seconds(x: number | null | undefined): string {
  if (!finite(x)) return NA;
  if (x < 10) return `${x.toFixed(1)} s`;
  if (x < 120) return `${Math.round(x)} s`;
  return `${(x / 60).toFixed(1)} min`;
}

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Tue 6 Oct 06:40 ET" */
export function nyTime(ts: number | null | undefined): string {
  if (!finite(ts)) return NA;
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute} ET`;
}

/** "2026-10-06 10:39 UTC" */
export function utcTime(ts: number | null | undefined): string {
  if (!finite(ts)) return NA;
  return `${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "6 Oct 2026" */
export function day(ts: number | null | undefined): string {
  if (!finite(ts)) return NA;
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ago(ts: number | null | undefined, now: number): string {
  if (!finite(ts)) return NA;
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const SESSION_LABEL: Record<string, string> = {
  pre_market: "Pre-market",
  regular: "Regular",
  after_hours: "After-hours",
  overnight: "Overnight",
  weekend: "Weekend",
  closed: "Closed",
};

export const VENUE_LABEL: Record<string, string> = { rtoken: "rToken", perp: "Perp" };

export const sessionLabel = (s: string) => SESSION_LABEL[s] ?? s;
export const venueLabel = (v: string) => VENUE_LABEL[v] ?? v;
