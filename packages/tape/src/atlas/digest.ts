// One pass over a closed tape hour → a small per-instrument digest (compact 1 s books, trades, compact REST depth).
// The atlas is rebuilt hourly from digests, so the VM never holds more than one instrument-session in memory.
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { bookFromBitget, type Venue } from "@slipway/core";
import { hourLines } from "../read.js";
import { type BookRecord, symbolOf, type TradeRecord, venueOf } from "../records.js";
import type { TapeSource } from "../source.js";
import { type PackedBook, packBook } from "./compact.js";

export const DIGEST_VERSION = 1;

/** [ts, px, sz, side (1 = buy, -1 = sell)] */
export type PackedTrade = [number, number, number, 1 | -1];

export interface InstrumentDigest {
  v: typeof DIGEST_VERSION;
  hour: string;
  venue: Venue;
  symbol: string;
  frames: PackedBook[]; // books15, ascending ts, one per exchange ts
  trades: PackedTrade[];
  depth: PackedBook[]; // REST full-depth snapshots, compacted
  oneSided: number; // snapshots dropped because a side was empty
}

const key = (venue: Venue, symbol: string) => `${venue === "rtoken" ? "R" : "P"}_${symbol}`;

function pushBook(map: Map<string, InstrumentDigest>, hour: string, r: BookRecord, into: "frames" | "depth") {
  const venue = venueOf(r);
  const symbol = symbolOf(r);
  if (!venue || !symbol) return;
  const d = entry(map, hour, venue, symbol);
  const book = bookFromBitget(r);
  if (!book.bids.length || !book.asks.length) {
    d.oneSided++;
    return;
  }
  d[into].push(packBook(book));
}

function entry(map: Map<string, InstrumentDigest>, hour: string, venue: Venue, symbol: string) {
  const k = key(venue, symbol);
  let d = map.get(k);
  if (!d) {
    d = { v: DIGEST_VERSION, hour, venue, symbol, frames: [], trades: [], depth: [], oneSided: 0 };
    map.set(k, d);
  }
  return d;
}

const dedupe = (xs: PackedBook[]): PackedBook[] => {
  xs.sort((a, b) => a.t - b.t);
  return xs.filter((x, i) => i === 0 || x.t !== (xs[i - 1] as PackedBook).t);
};

export async function digestHour(source: TapeSource, hour: string): Promise<Map<string, InstrumentDigest>> {
  const map = new Map<string, InstrumentDigest>();
  for (const stream of ["books", "depth"] as const) {
    for await (const line of hourLines(source, stream, hour)) {
      let r: BookRecord;
      try {
        r = JSON.parse(line) as BookRecord;
      } catch {
        continue;
      }
      pushBook(map, hour, r, stream === "books" ? "frames" : "depth");
    }
  }
  for await (const line of hourLines(source, "trades", hour)) {
    let r: TradeRecord;
    try {
      r = JSON.parse(line) as TradeRecord;
    } catch {
      continue;
    }
    const venue = venueOf(r);
    const symbol = symbolOf(r);
    const px = Number(r.px);
    const sz = Number(r.sz);
    if (!venue || !symbol || !(px > 0) || !(sz > 0)) continue;
    entry(map, hour, venue, symbol).trades.push([r.ts, px, sz, r.side === "buy" ? 1 : -1]);
  }
  for (const d of map.values()) {
    d.frames = dedupe(d.frames);
    d.depth = dedupe(d.depth);
    d.trades.sort((a, b) => a[0] - b[0]);
  }
  return map;
}

/** Digest store on disk: `<dir>/<hour>/<R|P>_<SYM>.json.gz` plus `<dir>/<hour>/_done` once the hour is complete. */
export class DigestStore {
  constructor(readonly dir: string) {}

  async hours(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const done: string[] = [];
    for (const n of names.sort()) {
      try {
        await readFile(join(this.dir, n, "_done"));
        done.push(n);
      } catch {}
    }
    return done;
  }

  async write(hour: string, digests: Map<string, InstrumentDigest>): Promise<void> {
    const dir = join(this.dir, hour);
    await mkdir(dir, { recursive: true });
    for (const [k, d] of digests) {
      const tmp = join(dir, `${k}.json.gz.tmp`);
      await writeFile(tmp, gzipSync(JSON.stringify(d)));
      await rename(tmp, join(dir, `${k}.json.gz`));
    }
    await writeFile(join(dir, "_done"), String(digests.size));
  }

  async read(hour: string, venue: Venue, symbol: string): Promise<InstrumentDigest | null> {
    try {
      return JSON.parse(
        gunzipSync(await readFile(join(this.dir, hour, `${key(venue, symbol)}.json.gz`))).toString(),
      ) as InstrumentDigest;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}
