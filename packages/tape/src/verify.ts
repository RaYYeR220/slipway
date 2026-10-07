// `pnpm verify`: zero-credential audit of everything Slipway publishes. Downloads the public ledger and anchors,
// verifies both hash chains, the plan signatures, the Merkle roots against the on-chain roots, re-grades a random
// sample of forecasts from the public tape, and runs negative controls that must fail.
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  canonicalJson,
  type ForecastEntry,
  type SignedPlan,
  sha256Hex,
  verifySignedPlan,
} from "@slipway/core";
import type { Hex } from "viem";
import { anchorClient, FORECAST_ANCHOR_ABI, readAnchors } from "./anchor/contract.js";
import type { AnchorFile } from "./anchor/job.js";
import { merkleProof, merkleRoot, verifyProof } from "./anchor/merkle.js";
import { mulberry32, PROTOCOL_HASH } from "./eval/protocol.js";
import { type BatchManifest, type SnapshotBundle, snapshotFor } from "./eval/run.js";
import { evalContext, type Graded, gradePlans, groupPlans } from "./grade/grade.js";
import { CHAINS, type ChainRead, checkChain, ObjectLedgerStore } from "./ledger.js";
import type { TapeSource } from "./source.js";
import type { ObjectStore } from "./store.js";

export type Status = "PASS" | "FAIL" | "SKIP";
export interface Check {
  name: string;
  status: Status;
  detail: string;
}

export interface VerifyOptions {
  store: ObjectStore;
  source: TapeSource;
  protocolPath?: string;
  rpc?: string;
  sample: number;
  seed: number;
  log?: (c: Check) => void;
}

const json = async <T>(store: ObjectStore, name: string): Promise<T | null> => {
  const got = await store.get(name);
  if (!got) return null;
  const buf = name.endsWith(".gz") ? gunzipSync(got.data) : got.data;
  return JSON.parse(buf.toString()) as T;
};

export async function runVerify(o: VerifyOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => {
    const c = { name, status, detail };
    checks.push(c);
    o.log?.(c);
  };
  const rand = mulberry32(o.seed);
  const pick = <T>(xs: readonly T[], n: number): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a.slice(0, n);
  };

  // 1. protocol
  if (o.protocolPath) {
    const h = await sha256Hex(canonicalJson(JSON.parse(await readFile(o.protocolPath, "utf8"))));
    add(
      "protocol",
      h === PROTOCOL_HASH ? "PASS" : "FAIL",
      `eval/protocol.json sha256(canonical) = ${h.slice(0, 16)}… (pinned ${PROTOCOL_HASH.slice(0, 16)}…)`,
    );
  }

  // 2. chains
  const ledger = new ObjectLedgerStore(o.store);
  const reads = {} as Record<(typeof CHAINS)[number], ChainRead>;
  for (const chain of CHAINS) {
    const read = await ledger.read(chain);
    reads[chain] = read;
    const c = await checkChain(read);
    const orphanNote = c.orphans.length ? `; ${c.orphans.length} orphaned object(s) outside the chain` : "";
    add(`${chain} chain`, c.ok ? "PASS" : "FAIL", `${c.detail}${orphanNote}`);
  }
  const evalEntries = reads.eval.entries;

  // 3. signatures of sampled eval batches
  const pub = await json<{ pubkey: string }>(o.store, "eval/pubkey.json");
  // batches registered after the chain was read (the scheduler keeps running) are left for the next run
  const inChain = new Set(reads.eval.objects.map((x) => x.name));
  const manifests = new Map<string, BatchManifest>();
  for (const name of await o.store.list("eval/batches/")) {
    const m = await json<BatchManifest>(o.store, name);
    if (m?.ledgerObject && inChain.has(m.ledgerObject)) manifests.set(m.batchId, m);
  }
  if (!pub || manifests.size === 0) add("plan signatures", "SKIP", "no eval batches published yet");
  else {
    const planHashes = new Set(evalEntries.map((e) => e.planHash));
    let ok = 0;
    let bad = 0;
    for (const m of pick([...manifests.values()], 3)) {
      const plans = await json<{ plans: { signed: SignedPlan }[] }>(o.store, m.plansObject);
      for (const p of plans?.plans ?? []) {
        const v = await verifySignedPlan(p.signed, pub.pubkey);
        if (v.ok && planHashes.has(p.signed.hash)) ok++;
        else bad++;
      }
    }
    add(
      "plan signatures",
      bad === 0 && ok > 0 ? "PASS" : "FAIL",
      `${ok} signed plans verified against eval/pubkey.json and found in the ledger, ${bad} failed`,
    );
  }

  // 4. anchors
  const cfg = await json<{ chainId: number; contract: Hex; rpc: string; genesisTs: number }>(
    o.store,
    "anchors/config.json",
  );
  let anchorRoot: Hex | null = null;
  if (!cfg)
    add(
      "anchors",
      "SKIP",
      "no anchors/config.json: the ForecastAnchor contract is not deployed yet; ledger entries are timestamped by the ledger only",
    );
  else {
    const client = anchorClient(o.rpc ?? cfg.rpc);
    const state = await readAnchors(client, cfg.contract);
    add(
      "protocol on-chain",
      state.protocolHash === `0x${PROTOCOL_HASH}` ? "PASS" : "FAIL",
      `contract protocolHash ${state.protocolHash}`,
    );
    const all = [
      ...reads.eval.entries.map((e) => ({ chain: "eval", e })),
      ...reads.trader.entries.map((e) => ({ chain: "trader", e })),
    ];
    let expectFrom = state.genesisTs;
    let failures = 0;
    for (const a of state.anchors) {
      const file = await json<AnchorFile>(o.store, `anchors/${a.index}.json`);
      const inWindow = all.filter(
        (x) => x.e.registeredAt >= a.fromTs * 1000 && x.e.registeredAt < a.toTs * 1000,
      );
      const leaves = file?.leaves.map((l) => l.hash) ?? [];
      const sameLeaves =
        file !== null &&
        inWindow.length === leaves.length &&
        inWindow.every((x, i) => x.e.hash === leaves[i]);
      const root = leaves.length ? merkleRoot(leaves) : null;
      const okA =
        sameLeaves &&
        root === a.root &&
        file?.root === a.root &&
        a.fromTs === expectFrom &&
        a.count === leaves.length;
      if (!okA) failures++;
      expectFrom = a.toTs;
      anchorRoot = a.root;
      if (okA && leaves.length) {
        const i = Math.floor(rand() * leaves.length);
        const onChain = await client.readContract({
          address: cfg.contract,
          abi: FORECAST_ANCHOR_ABI,
          functionName: "verify",
          args: [BigInt(a.index), `0x${leaves[i]}` as Hex, merkleProof(leaves, i)],
        });
        if (!onChain) failures++;
      }
    }
    add(
      "anchors",
      failures === 0 ? (state.anchors.length ? "PASS" : "SKIP") : "FAIL",
      `${state.anchors.length} on-chain anchor(s) on chain ${cfg.chainId} at ${cfg.contract}: roots recomputed from the ledger, windows contiguous from genesis ${state.genesisTs}, one inclusion proof per anchor checked by the contract; ${failures} failure(s)`,
    );
  }

  // 5. re-grade a sample from the public tape
  const published: Graded[] = [];
  for (const name of await o.store.list("grades/eval/")) {
    const rows = await json<Graded[]>(o.store, name);
    for (const g of rows ?? []) if (g.scope === "order" && g.status === "graded") published.push(g);
  }
  if (published.length === 0) add("re-grade", "SKIP", "no graded forecasts published yet");
  else {
    const sample = pick(published, o.sample);
    const plans = groupPlans(evalEntries).filter((p) => sample.some((g) => g.planHash === p.planHash));
    const byPlan = new Map(sample.map((g) => [g.planHash, g]));
    const bundles = new Map<string, SnapshotBundle | null>();
    const regraded = await gradePlans(o.source, {
      chain: "eval",
      plans,
      now: Date.now(),
      tapeEnd: Number.MAX_SAFE_INTEGER,
      context: async (p) => {
        const g = byPlan.get(p.planHash);
        const m = g?.batchId ? manifests.get(g.batchId) : undefined;
        if (!g || !m) return { missing: "manifest not found" };
        if (!bundles.has(m.batchId))
          bundles.set(m.batchId, await json<SnapshotBundle>(o.store, m.snapshotObject));
        const b = bundles.get(m.batchId);
        const snap = b && g.order !== undefined ? snapshotFor(b, g.order, p.order.symbol) : undefined;
        if (!snap) return { missing: "snapshot not found" };
        const extra: { batchId: string; order?: number; roles?: string[] } = { batchId: m.batchId };
        if (g.order !== undefined) extra.order = g.order;
        if (g.roles) extra.roles = g.roles;
        return evalContext(snap, extra);
      },
    });
    let match = 0;
    const mismatches: string[] = [];
    for (const g of sample) {
      const r = regraded.find((x) => x.hash === g.hash);
      const a = g.realized?.REPRODUCIBLE;
      const b = r?.realized?.REPRODUCIBLE;
      if (
        r?.status === "graded" &&
        a !== null &&
        a !== undefined &&
        b !== null &&
        b !== undefined &&
        Math.abs(a - b) < 1e-6
      )
        match++;
      else mismatches.push(`${g.id} published ${a?.toFixed(4)} re-graded ${b?.toFixed(4) ?? r?.reason}`);
    }
    add(
      "re-grade",
      mismatches.length === 0 ? "PASS" : "FAIL",
      `${match}/${sample.length} sampled order forecasts re-graded from the public tape to the published REPRODUCIBLE cost${mismatches.length ? `; mismatches: ${mismatches.slice(0, 3).join("; ")}` : ""}`,
    );
  }

  // 6. negative controls: each forgery must be caught
  const target = evalEntries.length ? Math.floor(rand() * evalEntries.length) : -1;
  if (target < 0) add("negative control", "SKIP", "empty eval chain");
  else {
    const forged: ForecastEntry[] = evalEntries.map((e, i) =>
      i === target ? { ...e, predicted: { ...e.predicted, p50: e.predicted.p50 - 0.5 } } : e,
    );
    const c = await checkChain({ ...reads.eval, entries: forged });
    const forgedEntry = { ...(evalEntries[target] as ForecastEntry), predicted: { p50: 0 } };
    const { hash: _h, prevHash: _p, ...body } = forgedEntry;
    const fakeHash = await sha256Hex(canonicalJson({ ...body, prevHash: forgedEntry.prevHash }));
    const leaves = evalEntries.slice(Math.max(0, target - 7), target + 8).map((e) => e.hash);
    const root = anchorRoot ?? merkleRoot(leaves);
    const proofOk = verifyProof(root, fakeHash, merkleProof(leaves, Math.min(target, 7)));
    let sigCaught = true;
    const m = [...manifests.values()][0];
    if (pub && m) {
      const plans = await json<{ plans: { signed: SignedPlan }[] }>(o.store, m.plansObject);
      const sp = plans?.plans[0]?.signed;
      if (sp) {
        const tampered = { ...sp, plan: { ...sp.plan, arrivalMid: sp.plan.arrivalMid * 1.0001 } };
        sigCaught = !(await verifySignedPlan(tampered, pub.pubkey)).ok;
      }
    }
    const caught = c.firstBad === target && !proofOk && sigCaught;
    add(
      "negative control",
      caught ? "PASS" : "FAIL",
      `forged p50 on entry ${target} → chain breaks at ${c.firstBad}; forged leaf → Merkle proof ${proofOk ? "ACCEPTED" : "rejected"}; tampered signed plan → ${sigCaught ? "rejected" : "ACCEPTED"}`,
    );
  }
  return checks;
}
