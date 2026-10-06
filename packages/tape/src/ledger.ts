// Write-once forecast ledger. Two independent hash chains: `eval` (only the VM scheduler appends) and `trader`
// (only the web app appends). Each append is one immutable object
//   ledger/<chain>/<YYYY-MM-DD>/<registeredAt>-<hash16>.jsonl   (one ForecastEntry per line)
// and the chain tip lives in ledger/<chain>/head.json, swapped with a generation precondition so two writers can
// never fork the chain: the loser's object is deleted (it was never referenced) and the append is retried.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chainForecasts,
  type ForecastBody,
  type ForecastEntry,
  GENESIS_PREV,
  verifyChain,
} from "@slipway/core";
import type { TokenProvider } from "./gcs.js";
import { FsObjectStore, GcsObjectStore, type ObjectStore, PreconditionFailed } from "./store.js";

export const CHAINS = ["eval", "trader"] as const;
export type Chain = (typeof CHAINS)[number];

export interface LedgerHead {
  chain: Chain;
  head: string; // hash of the last entry (GENESIS_PREV for an empty chain)
  count: number;
  objects: number;
  lastObject: string | null;
  lastRegisteredAt: number;
  updatedAt: number;
}

export interface AppendResult {
  object: string;
  entries: ForecastEntry[];
  head: LedgerHead;
}

export interface ChainRead {
  entries: ForecastEntry[];
  objects: { name: string; first: number; count: number }[];
  orphans: string[]; // objects not on the path from genesis to head (lost races or tampering)
  head: LedgerHead;
}

export interface LedgerStore {
  head(chain: Chain): Promise<LedgerHead>;
  append(chain: Chain, bodies: ForecastBody[], now?: number): Promise<AppendResult>;
  read(chain: Chain): Promise<ChainRead>;
}

/** Entries must be registered close to the write so a 30-min anchor window can never miss a late commit. */
export const MAX_REGISTRATION_LAG_MS = 60_000;

const headName = (chain: Chain) => `ledger/${chain}/head.json`;
const genesis = (chain: Chain): LedgerHead => ({
  chain,
  head: GENESIS_PREV,
  count: 0,
  objects: 0,
  lastObject: null,
  lastRegisteredAt: 0,
  updatedAt: 0,
});

export const objectName = (chain: Chain, registeredAt: number, lastHash: string): string =>
  `ledger/${chain}/${new Date(registeredAt).toISOString().slice(0, 10)}/${registeredAt}-${lastHash.slice(0, 16)}.jsonl`;

export const parseJsonl = (data: Buffer | string): ForecastEntry[] =>
  data
    .toString()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ForecastEntry);

export class ObjectLedgerStore implements LedgerStore {
  constructor(
    readonly store: ObjectStore,
    private readonly maxRetries = 5,
  ) {}

  private async readHead(chain: Chain): Promise<{ head: LedgerHead; generation: string }> {
    const got = await this.store.get(headName(chain));
    if (!got) return { head: genesis(chain), generation: "0" };
    return { head: JSON.parse(got.data.toString()) as LedgerHead, generation: got.generation };
  }

  async head(chain: Chain): Promise<LedgerHead> {
    return (await this.readHead(chain)).head;
  }

  async append(chain: Chain, bodies: ForecastBody[], now = Date.now()): Promise<AppendResult> {
    if (bodies.length === 0) throw new Error("nothing to append");
    const origin = chain === "eval" ? "eval" : "trader";
    for (const b of bodies) {
      if (b.origin !== origin) throw new Error(`${b.id}: origin ${b.origin} cannot go on the ${chain} chain`);
      if (Math.abs(now - b.registeredAt) > MAX_REGISTRATION_LAG_MS)
        throw new Error(
          `${b.id}: registeredAt ${b.registeredAt} is not within ${MAX_REGISTRATION_LAG_MS} ms of now`,
        );
    }
    for (let attempt = 0; ; attempt++) {
      const { head, generation } = await this.readHead(chain);
      const minReg = Math.min(...bodies.map((b) => b.registeredAt));
      if (minReg < head.lastRegisteredAt)
        throw new Error(`registeredAt ${minReg} precedes the chain tip (${head.lastRegisteredAt})`);
      const entries = await chainForecasts(head.head, bodies);
      const last = entries.at(-1) as ForecastEntry;
      const registeredAt = Math.max(...bodies.map((b) => b.registeredAt));
      const name = objectName(chain, registeredAt, last.hash);
      const objGen = await this.store.put(
        name,
        Buffer.from(`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`),
        {
          ifGenerationMatch: "0",
          contentType: "application/x-ndjson",
          gzip: true,
          cacheControl: "public, max-age=86400, immutable",
        },
      );
      const next: LedgerHead = {
        chain,
        head: last.hash,
        count: head.count + entries.length,
        objects: head.objects + 1,
        lastObject: name,
        lastRegisteredAt: registeredAt,
        updatedAt: now,
      };
      try {
        await this.store.put(headName(chain), Buffer.from(JSON.stringify(next)), {
          ifGenerationMatch: generation,
          contentType: "application/json",
          cacheControl: "no-cache, max-age=0",
        });
        return { object: name, entries, head: next };
      } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e;
        await this.store.delete(name, objGen);
        if (attempt >= this.maxRetries) throw new Error(`${chain} head kept moving; append abandoned`);
      }
    }
  }

  async read(chain: Chain): Promise<ChainRead> {
    const { head } = await this.readHead(chain);
    const names = (await this.store.list(`ledger/${chain}/`)).filter((n) => n.endsWith(".jsonl"));
    const objects = new Map<string, ForecastEntry[]>();
    for (const n of names) {
      const got = await this.store.get(n);
      if (got) objects.set(n, parseJsonl(got.data));
    }
    return assembleChain(head, objects);
  }
}

export class GcsLedgerStore extends ObjectLedgerStore {
  constructor(bucket: string, token: TokenProvider) {
    super(new GcsObjectStore(bucket, token));
  }
}

export class FsLedgerStore extends ObjectLedgerStore {
  constructor(dir: string) {
    super(new FsObjectStore(dir));
  }
}

/** What chain assembly needs from an immutable ledger object (cacheable forever). */
export interface ObjectSummary {
  name: string;
  prevHash: string; // link of its first entry
  lastHash: string;
  count: number;
  minRegisteredAt: number;
  maxRegisteredAt: number;
}

export const summarize = (name: string, es: readonly ForecastEntry[]): ObjectSummary => ({
  name,
  prevHash: (es[0] as ForecastEntry).prevHash,
  lastHash: (es.at(-1) as ForecastEntry).hash,
  count: es.length,
  minRegisteredAt: Math.min(...es.map((e) => e.registeredAt)),
  maxRegisteredAt: Math.max(...es.map((e) => e.registeredAt)),
});

/** Orders objects by following prevHash links from genesis to the head; anything off that path is an orphan. */
export function orderObjects(
  headHash: string,
  summaries: readonly ObjectSummary[],
): { ordered: ObjectSummary[]; orphans: string[] } {
  const byPrev = new Map<string, ObjectSummary[]>();
  for (const o of summaries) byPrev.set(o.prevHash, [...(byPrev.get(o.prevHash) ?? []), o]);
  const reaches = (start: ObjectSummary, used: Set<string>): boolean => {
    const seen = new Set(used);
    const stack = [start];
    while (stack.length) {
      const o = stack.pop() as ObjectSummary;
      if (seen.has(o.name)) continue;
      seen.add(o.name);
      if (o.lastHash === headHash) return true;
      stack.push(...(byPrev.get(o.lastHash) ?? []));
    }
    return false;
  };
  const ordered: ObjectSummary[] = [];
  const used = new Set<string>();
  let prev = GENESIS_PREV;
  while (prev !== headHash) {
    const candidates = (byPrev.get(prev) ?? []).filter((o) => !used.has(o.name));
    // on a fork, follow the branch that reaches the published head
    const next = candidates.find((o) => reaches(o, used)) ?? candidates[0];
    if (!next) break;
    used.add(next.name);
    ordered.push(next);
    prev = next.lastHash;
  }
  return {
    ordered,
    orphans: summaries
      .map((o) => o.name)
      .filter((n) => !used.has(n))
      .sort(),
  };
}

export function assembleChain(head: LedgerHead, objects: Map<string, ForecastEntry[]>): ChainRead {
  const summaries = [...objects].filter(([, es]) => es.length > 0).map(([n, es]) => summarize(n, es));
  const { ordered, orphans } = orderObjects(head.head, summaries);
  const entries: ForecastEntry[] = [];
  const order: ChainRead["objects"] = [];
  for (const o of ordered) {
    order.push({ name: o.name, first: entries.length, count: o.count });
    entries.push(...(objects.get(o.name) as ForecastEntry[]));
  }
  const empty = [...objects].filter(([, es]) => es.length === 0).map(([n]) => n);
  return { entries, objects: order, orphans: [...orphans, ...empty].sort(), head };
}

export interface ChainIndex {
  head: LedgerHead;
  objects: ObjectSummary[]; // chain order
  orphans: string[];
}

/**
 * Chain order from object summaries, kept in `cache` (objects are immutable): a job only loads the entries of the
 * objects it needs, so memory stays flat as the ledger grows.
 */
export async function chainIndex(
  store: ObjectStore,
  chain: Chain,
  cache: Map<string, ObjectSummary> = new Map(),
): Promise<ChainIndex> {
  const ledger = new ObjectLedgerStore(store);
  const head = await ledger.head(chain);
  const names = (await store.list(`ledger/${chain}/`)).filter((n) => n.endsWith(".jsonl"));
  const summaries: ObjectSummary[] = [];
  for (const n of names) {
    let s = cache.get(n);
    if (!s) {
      const es = await loadObject(store, n);
      if (es.length === 0) continue;
      s = summarize(n, es);
      cache.set(n, s);
    }
    summaries.push(s);
  }
  const { ordered, orphans } = orderObjects(head.head, summaries);
  return { head, objects: ordered, orphans };
}

export async function loadSummaryCache(file: string): Promise<Map<string, ObjectSummary>> {
  try {
    const xs = JSON.parse(await readFile(file, "utf8")) as ObjectSummary[];
    return new Map(xs.map((x) => [x.name, x]));
  } catch {
    return new Map();
  }
}

export async function saveSummaryCache(file: string, cache: Map<string, ObjectSummary>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify([...cache.values()]));
}

export async function loadObject(store: ObjectStore, name: string): Promise<ForecastEntry[]> {
  const got = await store.get(name);
  return got ? parseJsonl(got.data) : [];
}

export interface ChainCheck {
  chain: Chain;
  ok: boolean;
  entries: number;
  firstBad: number; // index of the first broken link/hash, -1 if intact
  headMatches: boolean;
  orphans: string[];
  detail: string;
}

export async function checkChain(read: ChainRead): Promise<ChainCheck> {
  const firstBad = await verifyChain(read.entries, GENESIS_PREV);
  const tip = read.entries.at(-1)?.hash ?? GENESIS_PREV;
  const headMatches = tip === read.head.head && read.entries.length === read.head.count;
  const ok = firstBad === -1 && headMatches;
  const detail = ok
    ? `${read.entries.length} entries, chain intact, head ${tip.slice(0, 16)}`
    : firstBad !== -1
      ? `entry ${firstBad} (${read.entries[firstBad]?.id}) breaks the chain`
      : `head.json (${read.head.count} entries, ${read.head.head.slice(0, 16)}) does not match the objects (${read.entries.length}, ${tip.slice(0, 16)})`;
  return {
    chain: read.head.chain,
    ok,
    entries: read.entries.length,
    firstBad,
    headMatches,
    orphans: read.orphans,
    detail,
  };
}
