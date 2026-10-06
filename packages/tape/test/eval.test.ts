import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { LoadedSnapshot } from "@slipway/bitget";
import { exportPublicKey, generateSigningKeys, type SignedPlan, verifySignedPlan } from "@slipway/core";
import { describe, expect, it } from "vitest";
import type { AtlasDoc } from "../src/atlas/build.js";
import { batchIdOf, drawBatch, loadProtocol } from "../src/eval/protocol.js";
import {
  type BatchManifest,
  manifestName,
  plansName,
  runBatch,
  type SnapshotBundle,
  snapshotsName,
} from "../src/eval/run.js";
import { checkChain, ObjectLedgerStore } from "../src/ledger.js";
import { FsObjectStore } from "../src/store.js";
import { readJson, tempDir } from "./helpers.js";

const PROTOCOL = fileURLToPath(new URL("../../../eval/protocol.json", import.meta.url));
// a real snapshot saved by a dry-run batch (MSTR, 2026-10-06 06:13 UTC, overnight)
const snap = readJson<LoadedSnapshot>("eval", "snapshot.json.gz");
const { batchStart } = readJson<{ batchStart: number }>("eval", "order.json");

const atlasDoc: AtlasDoc = {
  generatedAt: batchStart - 600_000,
  window: { from: batchStart - 8 * 3_600_000, to: batchStart - 600_000 },
  atlas: snap.atlas,
  gapSigmaBps: { MSTR: snap.gapSigmaBps as Record<string, number> },
  basisSigmaBpsPerSqrtHour: { MSTR: snap.basisSigmaBpsPerSqrtHour as number },
  coverage: {},
  flags: [],
};

describe("evaluation batch", () => {
  it("registers every protocol strategy once, signed, chained, with its inputs saved first", async () => {
    const protocol = await loadProtocol(PROTOCOL);
    const store = new FsObjectStore(tempDir());
    const ledger = new ObjectLedgerStore(store);
    const keys = await generateSigningKeys();
    const pubkey = await exportPublicKey(keys.publicKey);
    // every symbol of the batch is served from the same recorded MSTR snapshot, relabelled
    const loaded: string[] = [];
    const load = async (symbol: string): Promise<LoadedSnapshot> => {
      loaded.push(symbol);
      if (symbol !== "MSTR") throw new Error(`no recorded snapshot for ${symbol}`);
      return { ...snap, sources: snap.sources.filter((s) => s.id !== "slipway.atlas") };
    };
    const clock = () => snap.now + 1_500;
    const m = (await runBatch({
      protocol,
      store,
      ledger,
      atlas: atlasDoc,
      keys,
      pubkey,
      load,
      now: clock,
    })) as BatchManifest;
    expect(m.batchId).toBe(batchIdOf(batchStart));
    const orders = drawBatch(protocol, batchStart);
    expect(m.orders.map((o) => o.symbol)).toEqual(orders.map((o) => o.symbol));
    expect(loaded).toEqual([...new Set(orders.map((o) => o.symbol))]);
    const mstr = m.orders.filter((o) => o.symbol === "MSTR");
    expect(mstr.length).toBeGreaterThan(0);
    for (const o of m.orders) expect(o.status).toBe(o.symbol === "MSTR" ? "registered" : "no_snapshot");
    for (const o of mstr) {
      expect(Object.keys(o.roles)).toEqual(protocol.strategiesForecast);
      expect(o.roles.chosen).not.toBeNull();
      const distinct = new Set(Object.values(o.roles).filter(Boolean));
      expect(o.plans.map((p) => p.strategyId).sort()).toEqual([...distinct].sort());
      expect(o.plans.every((p) => p.verdict !== "refuse" || p.strategyId.startsWith("twap60"))).toBe(true);
    }
    const read = await ledger.read("eval");
    expect((await checkChain(read)).ok).toBe(true);
    expect(read.entries.length).toBe(m.entries);
    expect(read.entries.every((e) => e.origin === "eval" && e.registeredAt === m.registeredAt)).toBe(true);
    const bundle = JSON.parse(
      gunzipSync((await store.get(snapshotsName(m.batchId)))?.data as Buffer).toString(),
    ) as SnapshotBundle;
    expect(Object.keys(bundle.snapshots)).toEqual(["MSTR"]);
    expect(bundle.snapshots.MSTR?.books).toEqual(snap.books);
    expect(bundle.snapshots.MSTR?.sources.at(-1)?.id).toBe("slipway.atlas");
    const plans = JSON.parse(
      gunzipSync((await store.get(plansName(m.batchId)))?.data as Buffer).toString(),
    ) as {
      plans: { signed: SignedPlan }[];
    };
    for (const p of plans.plans) expect(await verifySignedPlan(p.signed, pubkey)).toEqual({ ok: true });
    expect(new Set(read.entries.map((e) => e.planHash))).toEqual(
      new Set(plans.plans.map((p) => p.signed.hash)),
    );
    expect(await store.get(manifestName(m.batchId))).not.toBeNull();
    // idempotent per 10-minute window
    expect(
      await runBatch({ protocol, store, ledger, atlas: atlasDoc, keys, pubkey, load, now: clock }),
    ).toBeNull();
  });

  it("never registers a window twice when an earlier attempt already saved its inputs", async () => {
    const protocol = await loadProtocol(PROTOCOL);
    const store = new FsObjectStore(tempDir());
    const ledger = new ObjectLedgerStore(store);
    const keys = await generateSigningKeys();
    const pubkey = await exportPublicKey(keys.publicKey);
    await store.put(snapshotsName(batchIdOf(batchStart)), Buffer.from("partial"), { ifGenerationMatch: "0" });
    const load = async () => snap;
    const m = await runBatch({
      protocol,
      store,
      ledger,
      atlas: atlasDoc,
      keys,
      pubkey,
      load,
      now: () => snap.now + 1_500,
    });
    expect(m).toBeNull();
    expect((await ledger.head("eval")).count).toBe(0);
  });
});
