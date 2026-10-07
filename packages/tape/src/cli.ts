#!/usr/bin/env node
// slipway-tape <atlas|eval|grade|anchor|publish> — the VM's scheduled jobs (systemd timers call these).
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BitgetRest, loadMarketSnapshot } from "@slipway/bitget";
import { PUBLIC_ARBITRUM_RPC } from "./anchor/contract.js";
import { publishAnchorConfig, runAnchorJob } from "./anchor/job.js";
import type { AtlasDoc } from "./atlas/build.js";
import { runAtlasJob } from "./atlas/job.js";
import { type Config, loadConfig } from "./config.js";
import { loadProtocol } from "./eval/protocol.js";
import { runBatch } from "./eval/run.js";
import { runGradeJob } from "./grade/job.js";
import { loadOrCreateKeys } from "./keys.js";
import { loadSummaryCache, ObjectLedgerStore, saveSummaryCache } from "./ledger.js";
import { PUBLIC_BASE } from "./source.js";
import { MirrorStore, PreconditionFailed, publishJson } from "./store.js";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/** Readers (the eval job reads the atlas) never see a half-written file. */
async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, path);
}

async function atlas() {
  const cfg = loadConfig();
  const t0 = Date.now();
  const doc = await runAtlasJob({
    source: cfg.source,
    work: cfg.work,
    rest: new BitgetRest(),
    symbols: cfg.symbols,
    now: Date.now(),
    log,
  });
  await mkdir(join(cfg.work, "derived"), { recursive: true });
  await writeAtomic(join(cfg.work, "derived", "atlas.json"), JSON.stringify(doc));
  if (process.env.NO_PUBLISH !== "1") await publishJson(await cfg.store(), "derived/atlas.json", doc);
  log(`atlas: ${Object.keys(doc.atlas).length} keys, ${doc.flags.length} flags, ${Date.now() - t0} ms`);
}

async function publish() {
  const cfg = loadConfig();
  const store = await cfg.store();
  for (const name of process.argv.slice(3)) {
    const doc = JSON.parse(await readFile(join(cfg.work, "derived", name), "utf8"));
    await publishJson(store, `derived/${name}`, doc);
    log(`published derived/${name}`);
  }
}

export async function currentAtlas(cfg: Config): Promise<AtlasDoc> {
  const local = join(cfg.work, "derived", "atlas.json");
  if (existsSync(local)) return JSON.parse(await readFile(local, "utf8")) as AtlasDoc;
  const res = await fetch(`${PUBLIC_BASE}/derived/atlas.json`);
  if (!res.ok) throw new Error(`atlas unavailable: HTTP ${res.status}`);
  return (await res.json()) as AtlasDoc;
}

function protocolPath(): string {
  const candidates = [
    process.env.PROTOCOL_PATH,
    join(process.cwd(), "eval", "protocol.json"),
    join(process.cwd(), "..", "..", "eval", "protocol.json"),
    "/opt/slipway/app/protocol.json",
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`protocol.json not found (looked in ${candidates.join(", ")})`);
  return found;
}

async function evalBatch() {
  const cfg = loadConfig();
  const protocol = await loadProtocol(protocolPath());
  const store = await cfg.store();
  const { keys, pubkey } = await loadOrCreateKeys(join(cfg.work, "keys", "eval-signing.json"));
  try {
    await store.put("eval/pubkey.json", Buffer.from(JSON.stringify({ alg: "Ed25519", pubkey })), {
      ifGenerationMatch: "0",
      contentType: "application/json",
    });
  } catch (e) {
    if (!(e instanceof PreconditionFailed)) throw e;
  }
  const atlas = await currentAtlas(cfg);
  const rest = new BitgetRest();
  const manifest = await runBatch({
    protocol,
    store,
    ledger: new ObjectLedgerStore(store),
    atlas,
    keys,
    pubkey,
    load: (symbol, a) => loadMarketSnapshot(symbol, { atlas: a, rest }),
    log,
  });
  if (manifest) log(`eval ${manifest.batchId}: ${manifest.entries} forecasts -> ${manifest.ledgerObject}`);
}

async function grade() {
  const cfg = loadConfig();
  const t0 = Date.now();
  const store = new MirrorStore(await cfg.store(), join(cfg.work, "mirror"));
  const { record: tr, points } = await runGradeJob({
    store,
    source: cfg.source,
    work: cfg.work,
    protocol: await loadProtocol(protocolPath()),
    atlas: await currentAtlas(cfg),
    rest: new BitgetRest(),
    now: Date.now(),
    log,
  });
  await mkdir(join(cfg.work, "derived"), { recursive: true });
  await writeAtomic(join(cfg.work, "derived", "track-record.json"), JSON.stringify(tr));
  await writeAtomic(join(cfg.work, "derived", "track-record-points.json"), JSON.stringify(points));
  if (process.env.NO_PUBLISH !== "1") {
    await publishJson(store, "derived/track-record.json", tr);
    await publishJson(store, "derived/track-record-points.json", points);
  }
  log(`track record: eval ${JSON.stringify(tr.counts.eval)}, ${Date.now() - t0} ms`);
}

async function anchor() {
  const cfg = loadConfig();
  const { ANCHOR_RPC: rpc, ANCHOR_CONTRACT: contract, ANCHOR_PK: pk } = process.env;
  if (!rpc || !contract || !pk) throw new Error("ANCHOR_RPC, ANCHOR_CONTRACT and ANCHOR_PK must be set");
  const store = new MirrorStore(await cfg.store(), join(cfg.work, "mirror"));
  const a = { rpc, contract: contract as `0x${string}`, privateKey: pk as `0x${string}` };
  const indexFile = join(cfg.work, "ledger-index.json");
  const cache = await loadSummaryCache(indexFile);
  await runAnchorJob(store, a, Date.now(), log, cache);
  await saveSummaryCache(indexFile, cache);
  await publishAnchorConfig(store, a, process.env.ANCHOR_PUBLIC_RPC ?? PUBLIC_ARBITRUM_RPC);
}

const commands: Record<string, () => Promise<void>> = { atlas, eval: evalBatch, grade, anchor, publish };

const cmd = process.argv[2] ?? "";
const run = commands[cmd];
if (!run) {
  console.error(`usage: slipway-tape <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
run().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
