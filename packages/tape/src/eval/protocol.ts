// The pre-registered evaluation protocol (eval/protocol.json, committed before any data): batch sampling and roles.
import { readFile } from "node:fs/promises";
import { canonicalJson, type Profile, type Side, sha256Hex } from "@slipway/core";

export interface Protocol {
  name: string;
  version: number;
  purpose: string;
  universe: string[];
  venues: ("rtoken" | "perp")[];
  orderSizesUsd: number[];
  sides: Side[];
  cadence: { everyMinutes: number; ordersPerBatch: number; sampling: string };
  seed: number;
  profile: Profile;
  strategiesForecast: string[];
  grading: Record<string, unknown>;
  reporting: string;
  anchoring: Record<string, string>;
}

/** sha256 of the canonical JSON of protocol.json as committed (8f6e3fd). Any edit must fail closed. */
export const PROTOCOL_HASH = "83106457269ee1d66dca866692b70e84bb4e6158a086dbc0ea19d7d788a31356";

export async function loadProtocol(path: string, expectedHash = PROTOCOL_HASH): Promise<Protocol> {
  const p = JSON.parse(await readFile(path, "utf8")) as Protocol;
  const h = await sha256Hex(canonicalJson(p));
  if (h !== expectedHash) throw new Error(`protocol ${path} hashes to ${h}, expected ${expectedHash}`);
  return p;
}

/** mulberry32 PRNG (32-bit state, uniform floats in [0, 1)). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EvalOrder {
  i: number;
  symbol: string;
  notionalUsd: number;
  side: Side;
}

export const batchMs = (p: Protocol) => p.cadence.everyMinutes * 60_000;
export const batchStartOf = (p: Protocol, now: number) => Math.floor(now / batchMs(p)) * batchMs(p);
export const batchIdOf = (batchStart: number) =>
  `${new Date(batchStart).toISOString().slice(0, 16).replace(/[-:]/g, "")}Z`;

/** Orders of the batch starting at `batchStart`: per order, symbol then size then side, uniform with replacement. */
export function drawBatch(p: Protocol, batchStart: number): EvalOrder[] {
  const rand = mulberry32(p.seed ^ Math.floor(batchStart / 60_000));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  return Array.from({ length: p.cadence.ordersPerBatch }, (_, i) => ({
    i,
    symbol: pick(p.universe),
    notionalUsd: pick(p.orderSizesUsd),
    side: pick(p.sides),
  }));
}
