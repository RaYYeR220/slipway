// Numeric provenance guard: every number the model writes must be traceable to a tool output of the same
// turn (or to the user's own words). Anything else is flagged and masked, so the desk fails closed on
// invented figures instead of letting them reach the trader.

export interface NumberToken {
  raw: string;
  index: number; // offset in the normalised text
  value: number; // in natural units (suffixes applied); NaN for verbatim-only tokens
  display: number; // as written, before suffix scaling
  decimals: number;
  signed: boolean; // an explicit + or − was written
  unit: "" | "%" | "k" | "M" | "B" | "time" | "date" | "word";
}

export interface GuardResult {
  ok: boolean;
  unverified: NumberToken[];
  redacted: string; // normalised text with unverified tokens masked
}

export interface GuardOptions {
  userText?: string;
  allow?: string[]; // raw tokens always allowed
}

const DATE = /(?<![\w:.-])(\d{4}-\d{2}-\d{2})(?![\w:])/g;
const TIME = /(?<![\w:.])(\d{1,2}:\d{2})(?![\w:])/g;
const NUM =
  /(?<![\w:.,·-])([-−+])?\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:(%)|(k|K|M|B|bn|bps|bp|h|m|s|d|x)(?![a-zA-Z]))?(?![\w:]|[.,]\d)/g;
// A run of identifier-ish characters; if it holds a digit no number token explains, it is checked verbatim.
const WORD = /[\p{L}\p{N}_.,:/-]*\p{Nd}[\p{L}\p{N}_.,:/-]*/gu;

const MULT: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, bn: 1e9 };
const REL_TOL = 0.05;

/** NFKC plus removal of invisible format characters (zero-width joiners, bidi marks). */
export function normalise(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

export function extractNumbers(input: string): NumberToken[] {
  const text = normalise(input);
  const out: NumberToken[] = [];
  const covered: [number, number][] = [];
  const free = (a: number, b: number) => !covered.some(([x, y]) => a < y && b > x);
  const verbatim = (raw: string, index: number, unit: "time" | "date" | "word"): NumberToken => ({
    raw,
    index,
    value: Number.NaN,
    display: Number.NaN,
    decimals: 0,
    signed: false,
    unit,
  });

  for (const [re, unit] of [
    [DATE, "date"],
    [TIME, "time"],
  ] as const) {
    for (const m of text.matchAll(re)) {
      const raw = m[1] as string;
      if (!free(m.index, m.index + raw.length)) continue;
      covered.push([m.index, m.index + raw.length]);
      out.push(verbatim(raw, m.index, unit));
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
    const unit: NumberToken["unit"] = m[3]
      ? "%"
      : scale === "K" || scale === "k"
        ? "k"
        : scale === "bn" || scale === "B"
          ? "B"
          : scale === "M"
            ? "M"
            : "";
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

  // Digits inside words ("x9bp", "8,5bp", "cost:79bps", "0x06cD", "sliced:perp:n12:t900") are never parsed as
  // numbers; such a word passes only if a tool or the user produced it verbatim.
  for (const m of text.matchAll(WORD)) {
    const word = m[0].replace(/[.,:/-]+$/, "");
    const a = m.index;
    let unexplained = false;
    for (let i = a; i < a + word.length; i++) {
      if (/\p{Nd}/u.test(text[i] as string) && free(i, i + 1)) {
        unexplained = true;
        break;
      }
    }
    if (unexplained) out.push(verbatim(word, a, "word"));
  }
  return out.sort((a, b) => a.index - b.index);
}

// Candidates are numeric fields and array lengths only. Numbers inside free-text strings (headlines,
// assumptions, echoed input) are not candidates, so injected text cannot vouch for a figure.
function collect(value: unknown, nums: number[], strings: string[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) nums.push(value);
  } else if (typeof value === "string") {
    strings.push(normalise(value));
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
      if (tok.signed && f !== 0 && Math.sign(f) !== Math.sign(tok.display)) continue;
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
  const userText = normalise(opts.userText ?? "");
  const userNums = extractNumbers(userText)
    .filter((t) => Number.isFinite(t.value))
    .map((t) => t.value);
  const allow = new Set(opts.allow ?? []);
  const seenVerbatim = (raw: string) => strings.some((s) => s.includes(raw)) || userText.includes(raw);

  const unverified: NumberToken[] = [];
  for (const tok of extractNumbers(text)) {
    if (allow.has(tok.raw)) continue;
    if (tok.unit === "word" || tok.unit === "time" || tok.unit === "date") {
      if (!seenVerbatim(tok.raw)) unverified.push(tok);
    } else if (!matches(tok, nums) && !matches(tok, userNums)) {
      unverified.push(tok);
    }
  }

  // Overlapping tokens (a number inside a rejected word) collapse into the widest span when masking.
  const spans = unverified
    .map((t) => [t.index, t.index + t.raw.length] as [number, number])
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]);
      else acc.push([...s]);
      return acc;
    }, []);
  let redacted = normalise(text);
  for (const [a, b] of spans.reverse()) redacted = `${redacted.slice(0, a)}[unverified]${redacted.slice(b)}`;
  return { ok: unverified.length === 0, unverified, redacted };
}
