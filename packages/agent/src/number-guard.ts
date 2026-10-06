// Numeric provenance guard: every number the model writes must be traceable to a tool output of the same
// turn (or to the user's own words). Anything else is flagged and masked, so the desk fails closed on
// invented figures instead of letting them reach the trader.

export interface NumberToken {
  raw: string;
  index: number;
  value: number; // in natural units (suffixes applied)
  display: number; // as written, before suffix scaling
  decimals: number;
  unit: "" | "%" | "k" | "M" | "B" | "time";
}

export interface GuardResult {
  ok: boolean;
  unverified: NumberToken[];
  redacted: string;
}

export interface GuardOptions {
  userText?: string;
  allow?: string[]; // raw tokens always allowed
}

const TIME = /(?<![\w:.])(\d{1,2}:\d{2})(?![\w:])/g;
const NUM =
  /(?<![\w:.·-])([-−+])?\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:(%)|(k|K|M|B|bn)(?![a-zA-Z]))?(?![\w:]|\.\d)/g;

const MULT: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, bn: 1e9 };

export function extractNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const timeSpans: [number, number][] = [];
  for (const m of text.matchAll(TIME)) {
    const raw = m[1] as string;
    timeSpans.push([m.index, m.index + raw.length]);
    out.push({ raw, index: m.index, value: Number.NaN, display: Number.NaN, decimals: 0, unit: "time" });
  }
  for (const m of text.matchAll(NUM)) {
    const start = m.index;
    if (timeSpans.some(([a, b]) => start >= a && start < b)) continue;
    const sign = m[1] === "-" || m[1] === "−" ? -1 : 1;
    const digits = (m[2] as string).replace(/,/g, "");
    const frac = digits.split(".")[1];
    const display = sign * Number(digits);
    const unit = (m[3] ?? (m[4] === "K" ? "k" : m[4] === "bn" ? "B" : m[4]) ?? "") as NumberToken["unit"];
    const mult = m[4] ? (MULT[m[4]] as number) : 1;
    out.push({
      raw: m[0],
      index: start,
      value: display * mult,
      display,
      decimals: frac ? frac.length : 0,
      unit,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function collect(value: unknown, nums: number[], strings: string[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) nums.push(value);
  } else if (typeof value === "string") {
    strings.push(value);
    for (const t of extractNumbers(value)) if (t.unit !== "time") nums.push(t.value);
  } else if (Array.isArray(value)) {
    nums.push(value.length);
    for (const v of value) collect(v, nums, strings);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collect(v, nums, strings);
  }
}

function roundTo(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function matches(tok: NumberToken, candidates: number[]): boolean {
  const target = Math.abs(tok.display);
  const mult = tok.unit === "k" ? 1e3 : tok.unit === "M" ? 1e6 : tok.unit === "B" ? 1e9 : 1;
  for (const y of candidates) {
    const forms = tok.unit === "%" ? [y, y * 100] : [y / mult];
    for (const f of forms) {
      if (Math.abs(roundTo(Math.abs(f), tok.decimals) - target) < 1e-9) return true;
    }
  }
  return false;
}

export function checkNumbers(text: string, toolOutputs: unknown[], opts: GuardOptions = {}): GuardResult {
  const nums: number[] = [];
  const strings: string[] = [];
  for (const o of toolOutputs) collect(o, nums, strings);
  const userTokens = opts.userText ? extractNumbers(opts.userText) : [];
  const userNums = userTokens.filter((t) => t.unit !== "time").map((t) => t.value);
  const allow = new Set(opts.allow ?? []);

  const unverified: NumberToken[] = [];
  for (const tok of extractNumbers(text)) {
    if (allow.has(tok.raw)) continue;
    if (tok.unit === "time") {
      const seen = strings.some((s) => s.includes(tok.raw)) || (opts.userText ?? "").includes(tok.raw);
      if (!seen) unverified.push(tok);
      continue;
    }
    if (matches(tok, nums) || matches(tok, userNums)) continue;
    unverified.push(tok);
  }

  let redacted = text;
  for (const tok of [...unverified].sort((a, b) => b.index - a.index)) {
    redacted = `${redacted.slice(0, tok.index)}[unverified]${redacted.slice(tok.index + tok.raw.length)}`;
  }
  return { ok: unverified.length === 0, unverified, redacted };
}
