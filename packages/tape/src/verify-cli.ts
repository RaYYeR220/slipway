#!/usr/bin/env node
// pnpm verify [--bucket <name>] [--sample <n>] [--seed <n>] [--rpc <url>] [--protocol <path>]
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CachedTapeSource, HttpTapeSource, PUBLIC_BUCKET } from "./source.js";
import { MirrorStore, PublicObjectStore } from "./store.js";
import { runVerify } from "./verify.js";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    bucket: { type: "string", default: PUBLIC_BUCKET },
    sample: { type: "string", default: "12" },
    seed: { type: "string" },
    rpc: { type: "string" },
    protocol: { type: "string" },
  },
});
const bucket = values.bucket as string;
const seed = values.seed !== undefined ? Number(values.seed) : Date.now() % 2 ** 31;
const cache = join(tmpdir(), "slipway-verify", bucket);
const protocolPath =
  values.protocol ??
  [
    join(process.cwd(), "eval", "protocol.json"),
    join(process.cwd(), "..", "..", "eval", "protocol.json"),
  ].find(existsSync);

console.log(`Slipway public verification — gs://${bucket} (no credentials), sample seed ${seed}`);
const checks = await runVerify({
  store: new MirrorStore(new PublicObjectStore(bucket), join(cache, "objects")),
  source: new CachedTapeSource(new HttpTapeSource(bucket), join(cache, "tape")),
  ...(protocolPath ? { protocolPath } : {}),
  ...(values.rpc ? { rpc: values.rpc } : {}),
  sample: Number(values.sample),
  seed,
  log: (c) => console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(18)} ${c.detail}`),
});
const failed = checks.filter((c) => c.status === "FAIL").length;
const skipped = checks.filter((c) => c.status === "SKIP").length;
console.log(
  `${failed ? "FAIL" : "PASS"}: ${checks.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`,
);
process.exit(failed ? 1 : 0);
