import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RawBook {
  instType: "SPOT" | "USDT-FUTURES";
  instId: string;
  ts: number;
  rx?: number;
  asks: (string | number)[][];
  bids: (string | number)[][];
}

export interface RawTicker {
  instId: string;
  ts: number;
  mark: string;
  index: string;
  funding: string;
  nextFunding: string;
}

export interface Moment {
  utc: string;
  ts: number;
  [instId: string]: unknown;
}

export interface SequenceFixture {
  instType: "SPOT" | "USDT-FUTURES";
  instId: string;
  from: number;
  to: number;
  books: { ts: number; asks: [number, number][]; bids: [number, number][] }[];
  trades: { ts: number; px: number; sz: number; side: "buy" | "sell" }[];
  depth?: { ts: number; asks: [number, number][]; bids: [number, number][] }[];
}

const cache = new Map<string, unknown>();

export function fixture<T>(name: string): T {
  if (!cache.has(name)) {
    const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
    cache.set(name, JSON.parse(readFileSync(path, "utf8")));
  }
  return cache.get(name) as T;
}

export function instrument(file: string, moment: string, instId: string) {
  const m = fixture<Record<string, Moment>>(file)[moment] as Moment;
  return m[instId] as { books15: RawBook; depth: RawBook; ticker?: RawTicker };
}

// Deterministic PRNG for property-style tests.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}
