// Cuts real recorded slices into test/fixtures (each < 200 KB). Usage:
//   tsx scripts/make-fixtures.ts <tapeDir> <evalStoreDir> <candleCacheDir>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const [tapeDir, storeDir, candleDir] = process.argv.slice(2) as [string, string, string];
const out = new URL("../test/fixtures/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const lines = (stream: string, hour: string) =>
  gunzipSync(readFileSync(join(tapeDir, stream, `${hour}.jsonl.gz`)), { finishFlush: 2 })
    .toString()
    .split("\n")
    .filter(Boolean);

function cut(
  dir: string,
  hour: string,
  keep: (r: { instId?: string; ts?: number }) => boolean,
  streams: string[],
) {
  for (const s of streams) {
    const kept = lines(s, hour).filter((l) => {
      try {
        return keep(JSON.parse(l));
      } catch {
        return false;
      }
    });
    mkdirSync(join(out, dir, s), { recursive: true });
    const gz = gzipSync(`${kept.join("\n")}\n`);
    writeFileSync(join(out, dir, s, `${hour}.jsonl.gz`), gz);
    console.log(dir, s, kept.length, "lines", gz.length, "bytes");
  }
}

// 1) NVDA, both venues, 04:20:00–04:24:00 UTC (overnight session)
const t0 = Date.parse("2026-10-06T04:20:00Z");
const t1 = Date.parse("2026-10-06T04:24:00Z");
cut(
  "tape",
  "2026-10-06T04",
  (r) => (r.instId === "NVDAUSDT" || r.instId === "RNVDAUSDT") && (r.ts ?? 0) >= t0 && (r.ts ?? 0) <= t1,
  ["books", "depth", "trades", "tickers"],
);

// 2) truncated copy of the books hour (an hour still being written)
const full = readFileSync(join(out, "tape", "books", "2026-10-06T04.jsonl.gz"));
mkdirSync(join(out, "tape-open", "books"), { recursive: true });
writeFileSync(
  join(out, "tape-open", "books", "2026-10-06T04.jsonl.gz"),
  full.subarray(0, Math.floor(full.length * 0.6)),
);

// 3) eval batch: one order's plans, its saved snapshot, and the tape around its slices
const ledgerObj = readdirSync(join(storeDir, "ledger/eval"), { recursive: true })
  .map(String)
  .find((n) => n.endsWith(".jsonl")) as string;
const entries = readFileSync(join(storeDir, "ledger/eval", ledgerObj), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const batch = readdirSync(join(storeDir, "eval/batches"))[0] as string;
const manifest = JSON.parse(readFileSync(join(storeDir, "eval/batches", batch), "utf8"));
const order = manifest.orders.find(
  (o: { symbol: string; status: string }) => o.symbol === process.env.FIX_SYMBOL && o.status === "registered",
);
const hashes = new Set(order.plans.map((p: { planHash: string }) => p.planHash));
const mine = entries.filter((e: { planHash: string }) => hashes.has(e.planHash));
const bundle = JSON.parse(gunzipSync(readFileSync(join(storeDir, manifest.snapshotObject))).toString());
const snap = bundle.snapshots[order.symbol];
mkdirSync(join(out, "eval"), { recursive: true });
writeFileSync(join(out, "eval", "entries.json"), JSON.stringify(mine));
writeFileSync(
  join(out, "eval", "order.json"),
  JSON.stringify({ batchId: manifest.batchId, batchStart: manifest.batchStart, order }),
);
writeFileSync(join(out, "eval", "snapshot.json.gz"), gzipSync(JSON.stringify(snap)));
console.log("eval entries", mine.length, "snapshot gz", gzipSync(JSON.stringify(snap)).length);
const times = mine.map((e: { at: number }) => e.at);
const lo = Math.min(...times) - 5_000;
const hi = Math.max(...times) + 65_000;
const inst = new Set([`${order.symbol}USDT`, `R${order.symbol}USDT`]);
const hour = new Date(lo).toISOString().slice(0, 13);
cut("eval-tape", hour, (r) => inst.has(r.instId ?? "") && (r.ts ?? 0) >= lo && (r.ts ?? 0) <= hi, [
  "books",
  "trades",
  "tickers",
]);

// 4) 60 days of NVDA 1 h candles, both venues
const candles = {
  rtoken: JSON.parse(readFileSync(join(candleDir, "rtoken-NVDA-1h.json"), "utf8")),
  perp: JSON.parse(readFileSync(join(candleDir, "perp-NVDA-1h.json"), "utf8")),
};
writeFileSync(join(out, "nvda-candles-1h.json.gz"), gzipSync(JSON.stringify(candles)));
console.log("candles", candles.rtoken.length, candles.perp.length);
