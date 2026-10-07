// Human wording for identifiers in track-record.json. Unknown identifiers pass through unchanged.

import type { Comparison, LossRow } from "../site/data";
import { usd } from "../site/fmt";
import type { ForestRow } from "./Forest";

export function groupLabel(g: string): string {
  const [k, v = ""] = g.split("=");
  if (k === "size") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? `${usd(n)} orders` : g;
  }
  if (k === "symbol") return v;
  if (k === "session") return v.replace("_", "-");
  if (k === "venue") return v === "rtoken" ? "rToken" : v;
  return g;
}

export function comparisonLabel(c: string): { baseline: string; label: string | null } {
  const m = /chosen vs (\w+)\s*\((\w+)\)/.exec(c);
  if (!m) return { baseline: c, label: null };
  const base =
    m[1] === "twap60" ? "TWAP-60" : m[1] === "immediate" ? "an immediate market order" : (m[1] ?? c);
  return { baseline: base, label: m[2] ?? null };
}

export const BASELINES = [
  { key: "vsImmediate", label: "vs immediate", long: "Against one market order now" },
  { key: "vsTwap60", label: "vs TWAP-60", long: "Against a 60-second TWAP" },
] as const;

export function forestRows(
  h2h: { vsImmediate?: Comparison | null; vsTwap60?: Comparison | null } | undefined,
): ForestRow[] {
  if (!h2h) return [];
  const out: ForestRow[] = [];
  for (const b of BASELINES) {
    const c = h2h[b.key];
    if (!c?.n) continue;
    out.push({
      key: b.key,
      label: b.long,
      sub: `${c.n} paired orders`,
      mean: c.meanDiffBps,
      lo: c.ci95[0],
      hi: c.ci95[1],
      wins: c.wins,
      losses: c.losses,
      ties: c.ties,
    });
  }
  return out;
}

export function lossesFor(losses: LossRow[], label: string): LossRow[] {
  return losses.filter((l) => comparisonLabel(l.comparison).label === label);
}

export const LABEL_TEXT: Record<string, string> = {
  REPRODUCIBLE:
    "Shadow fill on the recorded book: each slice walks the book as it printed, without our own impact carried over.",
  MODELED:
    "Our own depletion carried over between slices, decaying with the measured resilience half-life (60 s prior where none).",
  BOUND: "No refill within the order: our depletion persists, an upper bound on own impact.",
};
