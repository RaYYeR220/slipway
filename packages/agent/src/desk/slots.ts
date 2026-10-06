import { nyParts } from "@slipway/core";
import type { Slot, SlotUnit } from "../slots.js";

export type Slots = Record<string, Slot>;

export type { DeskResult } from "@slipway/sdk";

const seg = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Thu 2026-10-08 09:45 NY". */
export function nyText(ts: number): string {
  const p = nyParts(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[p.weekday]} ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} NY`;
}

export class SlotBag {
  constructor(
    readonly slots: Slots = {},
    private readonly prefix = "",
  ) {}

  scope(prefix: string): SlotBag {
    return new SlotBag(this.slots, `${this.prefix}${prefix.split(".").map(seg).join(".")}.`);
  }

  put(
    name: string,
    value: number | string | null | undefined,
    unit: SlotUnit,
    source: string,
    opts?: { dp?: number; signed?: boolean },
  ): this {
    if (value === null || value === undefined) return this;
    if (typeof value === "number" && !Number.isFinite(value)) return this;
    const slot: Slot = { value, unit, source };
    if (opts?.dp !== undefined) slot.dp = opts.dp;
    if (opts?.signed) slot.signed = true;
    this.slots[`${this.prefix}${name.split(".").map(seg).join(".")}`] = slot;
    return this;
  }

  bps = (n: string, v: number | null | undefined, src: string, dp = 1, signed = false) =>
    this.put(n, v, "bps", src, { dp, signed });
  usd = (n: string, v: number | null | undefined, src: string, dp = 0) => this.put(n, v, "usd", src, { dp });
  price = (n: string, v: number | null | undefined, src: string, dp = 2) =>
    this.put(n, v, "price", src, { dp });
  qty = (n: string, v: number | null | undefined, src: string, dp = 4) => this.put(n, v, "qty", src, { dp });
  pct = (n: string, v: number | null | undefined, src: string, dp = 2, signed = false) =>
    this.put(n, v, "pct", src, { dp, signed });
  count = (n: string, v: number | null | undefined, src: string) => this.put(n, v, "count", src);
  seconds = (n: string, v: number | null | undefined, src: string) => this.put(n, v, "seconds", src);
  text = (n: string, v: string | null | undefined, src: string) => this.put(n, v, "text", src);
  time = (n: string, ts: number | null | undefined, src: string) =>
    this.put(n, ts === null || ts === undefined ? null : nyText(ts), "text", src);
}
