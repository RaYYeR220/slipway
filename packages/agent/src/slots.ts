// The model never writes a number. Every figure on screen is a slot reference ({{name}}) that code fills
// from a tool result and links to its source; any numeral the model types itself, in any script or spelled
// out, is masked. Provenance holds by construction instead of by pattern-matching the model's prose.

export type SlotUnit = "bps" | "usd" | "pct" | "count" | "qty" | "price" | "seconds" | "text";

export interface Slot {
  value: number | string;
  unit: SlotUnit;
  dp?: number; // decimal places for numeric slots
  signed?: boolean; // always show the sign
  source: string; // SourceRef id or "user" / "planner" / "gate"
}

export type Part =
  | { kind: "text"; text: string }
  | { kind: "slot"; name: string; text: string; source: string }
  | { kind: "flag"; raw: string; text: string };

export interface Rendered {
  ok: boolean;
  text: string;
  parts: Part[];
  flags: { raw: string; reason: "numeral" | "number-word" | "unknown-slot" | "bad-slot" }[];
}

const SLOT = /\{\{([^{}]*)\}\}/g;
const SLOT_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
// Any numeric character (decimal digits in every script, superscripts, vulgar fractions, roman numerals,
// circled numbers) plus an adjacent run of word characters, so "x9bp" is masked as a whole.
const NUMERAL = /[\p{L}\p{M}_]*\p{N}[\p{L}\p{M}\p{N}_.,:%/-]*/gu;
const NUMBER_WORDS =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|halves|third|thirds|quarter|quarters|fifth|tenth|double|triple|twice|thrice|percent)\b/giu;

function formatNumber(x: number, dp: number, signed: boolean): string {
  const s = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (x < 0) return `−${s}`;
  return signed && x > 0 ? `+${s}` : s;
}

export function formatSlot(slot: Slot): string {
  if (slot.unit === "text" || typeof slot.value === "string") return String(slot.value);
  const v = slot.value;
  const signed = slot.signed ?? false;
  switch (slot.unit) {
    case "bps":
      return `${formatNumber(v, slot.dp ?? 1, signed)} bp`;
    case "usd":
      return `${v < 0 ? "−" : ""}$${formatNumber(Math.abs(v), slot.dp ?? 0, false)}`;
    case "pct":
      return `${formatNumber(v * 100, slot.dp ?? 2, signed)}%`;
    case "seconds":
      return `${formatNumber(v, slot.dp ?? 0, false)} s`;
    case "count":
      return formatNumber(v, 0, false);
    default:
      return formatNumber(v, slot.dp ?? 2, signed);
  }
}

function maskProse(text: string, parts: Part[], flags: Rendered["flags"]): void {
  const hits: { a: number; b: number; raw: string; reason: "numeral" | "number-word" }[] = [];
  for (const m of text.matchAll(NUMERAL)) hits.push({ a: m.index, b: m.index + m[0].length, raw: m[0], reason: "numeral" });
  for (const m of text.matchAll(NUMBER_WORDS)) {
    if (!hits.some((h) => m.index < h.b && m.index + m[0].length > h.a)) {
      hits.push({ a: m.index, b: m.index + m[0].length, raw: m[0], reason: "number-word" });
    }
  }
  hits.sort((x, y) => x.a - y.a);
  let cursor = 0;
  for (const h of hits) {
    if (h.a > cursor) parts.push({ kind: "text", text: text.slice(cursor, h.a) });
    const raw = h.raw.replace(/[.,:/-]+$/, "");
    parts.push({ kind: "flag", raw, text: "[unverified]" });
    flags.push({ raw, reason: h.reason });
    cursor = h.a + raw.length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
}

export function renderModelText(input: string, slots: Record<string, Slot>): Rendered {
  // Letter-like and other numerals (Ⅳ, ½, ², ①) would lose their numeric class under NFKC, so pin them to a
  // plain digit first; they are then masked like any other numeral.
  const text = input
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Nl}\p{No}]/gu, "0")
    .normalize("NFKC");
  const parts: Part[] = [];
  const flags: Rendered["flags"] = [];
  let cursor = 0;
  for (const m of text.matchAll(SLOT)) {
    maskProse(text.slice(cursor, m.index), parts, flags);
    const name = (m[1] as string).trim();
    const slot = SLOT_NAME.test(name) ? slots[name] : undefined;
    if (slot) {
      parts.push({ kind: "slot", name, text: formatSlot(slot), source: slot.source });
    } else {
      const reason = SLOT_NAME.test(name) ? "unknown-slot" : "bad-slot";
      parts.push({ kind: "flag", raw: m[0], text: "[unknown]" });
      flags.push({ raw: m[0], reason });
    }
    cursor = m.index + m[0].length;
  }
  maskProse(text.slice(cursor), parts, flags);
  return { ok: flags.length === 0, text: parts.map((p) => p.text).join(""), parts, flags };
}
