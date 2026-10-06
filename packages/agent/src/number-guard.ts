// Numeric provenance guard: every number the model writes must be traceable to a tool output of the same
// turn (or to the user's own words). Anything else is flagged and masked, so the desk fails closed on
// invented figures instead of letting them reach the trader.

export interface NumberToken {
  raw: string;
  index: number;
  value: number; // in natural units (suffixes applied)
  display: number; // as written, before suffix scaling
  decimals: number;
  signed: boolean; // an explicit + or − was written
  unit: "" | "%" | "k" | "M" | "B" | "time" | "date" | "glued";
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

const DATE = /(?<![\w:.-])(\d{4}-\d{2}-\d{2})(?![\w:])/g;
const TIME = /(?<![\w:.])(\d{1,2}:\d{2})(?![\w:])/g;
const NUM =
  /(?<![\w:.,·-])([-−+])?\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:(%)|(k|K|M|B|bn|bps|bp|h|m|s|d|x)(?![a-zA-Z]))?(?![\w:]|[.,]\d)/g;
// Identifiers that legitimately contain digits. Everything else with a digit in it is checked.
const IDENTIFIERS = [
  /\b0x[0-9a-fA-F]{4,}\b/g, // addresses, hashes
  /\b[a-z_]+(?::[A-Za-z0-9_]+)+\b/g, // strategy ids such as sliced:perp:n12:t900
  /\bR?[A-Z]{2,6}USDT\b/g, // exchange symbols
  /\b[vV]\d+(?:\.\d+)*\b/g, // versions
];

const MULT: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, bn: 1e9 };
const REL_TOL = 0.05;

export function extractNumbers(input: string): NumberToken[] {
  const text = input.normalize("NFKC");
  const out: NumberToken[] = [];
  const covered: [number, number][] = [];
  const free = (a: number, b: number) => !covered.some(([x, y]) => a < y && b > x);

  for (const re of IDENTIFIERS) for (const m of text.matchAll(re)) covered.push([m.index, m.index + m[0].length]);

  for (const [re, unit] of [
    [DATE, "date"],
    [TIME, "time"],
  ] as const) {
    for (const m of text.matchAll(re)) {
      const raw = m[1] as string;
      if (!free(m.index, m.index + raw.length)) continue;
      covered.push([m.index, m.index + raw.length]);
      out.push({ raw, index: m.index, value: Number.NaN, display: Number.NaN, decimals: 0, signed: false, unit });
    }
  }

  for (const m of text.matchAll(NUM)) {
    const start = m.index;
    if (!free(start, start + m[0].length)) continue;
    covered.push([start, start + m[0].length]);
    const signed = m[1] !== undefined;
    const sign = m[1] === "-" || m[1] === "−" ? -1 : 1;
    const digits = (m[2] as string).replace(/,/g, "");
    const frac = digits.split(".")[1];
    const display = sign * Number(digits);
    const scale = m[4] && m[4] in MULT ? m[4] : undefined;
    const unit: NumberToken["unit"] = m[3] ? "%" : scale ? (scale === "K" ? "k" : scale === "bn" ? "B" : (scale as "k" | "M" | "B")) : "";
    out.push({
      raw: m[0],
      index: start,
      value: display * (scale ? (MULT[scale] as number) : 1),
      display,
      decimals: frac ? frac.length : 0,
      signed,
      unit,
    });
  }

  // Any digit left uncovered sits inside a word ("x9bp", "8,5bp"): unparseable, so it can never be verified.
  for (const m of text.matchAll(/[\p{L}\p{N}_.,]*\p{Nd}[\p{L}\p{N}_.,]*/gu)) {
    const word = m[0].replace(/[.,]+$/, "");
    const a = m.index;
    const b = a + word.length;
    let digitFree = false;
    for (let i = a; i < b; i++) {
      if (/\p{Nd}/u.test(text[i] as string) && free(i, i + 1)) {
        digitFree = true;
        break;
      }
    }
    if (digitFree) {
      out.push({ raw: word, index: a, value: Number.NaN, display: Number.NaN, decimals: 0, signed: false, unit: "glued" });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function collect(value: unknown, nums: number[], strings: string[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) nums.push(value);
  } else if (typeof value === "string") {
    strings.push(value);
    for (const t of extractNumbers(value)) if (Number.isFinite(t.value)) nums.push(t.value);
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

// A token matches a candidate when it is the candidate rounded at the token's own precision, within 5%
// of it (so coarse rounding cannot stretch a number), and with the same sign whenever a sign was written.
function matches(tok: NumberToken, candidates: number[]): boolean {
  const mult = tok.unit === "k" ? 1e3 : tok.unit === "M" ? 1e6 : tok.unit === "B" ? 1e9 : 1;
  for (const y of candidates) {
    const forms = tok.unit === "%" ? [y, y * 100] : [y / mult];
    for (const f of forms) {
      if (tok.signed && Math.sign(f) !== Math.sign(tok.display) && f !== 0) continue;
      const shown = tok.signed ? roundTo(f, tok.decimals) : roundTo(Math.abs(f), tok.decimals);
      const target = tok.signed ? tok.display : Math.abs(tok.display);
      if (Math.abs(shown - target) > 1e-9) continue;
      if (Math.abs(Math.abs(f) - Math.abs(tok.display)) > REL_TOL * Math.abs(tok.display) + 1e-9) continue;
      return true;
    }
  }
  return false;
}

export function checkNumbers(text: string, toolOutputs: unknown[], opts: GuardOptions = {}): GuardResult {
  const nums: number[] = [];
  const strings: string[] = [];
  for (const o of toolOutputs) collect(o, nums, strings);
  const userText = (opts.userText ?? "").normalize("NFKC");
  const userNums = extractNumbers(userText)
    .filter((t) => Number.isFinite(t.value))
    .map((t) => t.value);
  const allow = new Set(opts.allow ?? []);

  const unverified: NumberToken[] = [];
  for (const tok of extractNumbers(text)) {
    if (allow.has(tok.raw)) continue;
    if (tok.unit === "glued") {
      unverified.push(tok);
    } else if (tok.unit === "time" || tok.unit === "date") {
      if (!strings.some((s) => s.includes(tok.raw)) && !userText.includes(tok.raw)) unverified.push(tok);
    } else if (!matches(tok, nums) && !matches(tok, userNums)) {
      unverified.push(tok);
    }
  }

  const norm = text.normalize("NFKC");
  let redacted = norm;
  for (const tok of [...unverified].sort((a, b) => b.index - a.index)) {
    redacted = `${redacted.slice(0, tok.index)}[unverified]${redacted.slice(tok.index + tok.raw.length)}`;
  }
  return { ok: unverified.length === 0, unverified, redacted };
}
