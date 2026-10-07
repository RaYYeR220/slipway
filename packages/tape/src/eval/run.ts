// One pre-registered evaluation batch: draw orders, load live snapshots, plan every protocol strategy, gate, sign,
// derive forecasts and append them to the eval chain. Inputs are saved first so grading and ablation replay them.
import { gzipSync } from "node:zlib";
import type { LoadedSnapshot } from "@slipway/bitget";
import {
  type Atlas,
  buildPlan,
  type ForecastBody,
  forecastsFromPlan,
  type GateResult,
  type MarketSnapshot,
  MODEL_VERSION,
  type PlanResult,
  planExecution,
  runGate,
  type SignedPlan,
  type SourceRef,
  type StrategyQuote,
  sha256Hex,
  signPlan,
} from "@slipway/core";
import type { AtlasDoc } from "../atlas/build.js";
import { BUILD, type BuildInfo } from "../build-info.js";
import type { LedgerStore } from "../ledger.js";
import { type ObjectStore, PreconditionFailed } from "../store.js";
import {
  batchIdOf,
  batchStartOf,
  drawBatch,
  type EvalOrder,
  PROTOCOL_HASH,
  type Protocol,
} from "./protocol.js";

export type SnapshotLoader = (symbol: string, atlas: Atlas) => Promise<LoadedSnapshot>;

/** Candidate for a protocol role, or null when the planner produced none (e.g. venue closed, TWAP of one clip). */
export function strategyForRole(result: PlanResult, role: string): StrategyQuote | null {
  const [kind, arg] = role.split(":");
  if (role === "chosen") return result.best;
  if (kind === "immediate") return result.candidates.find((c) => c.id === `immediate:${arg}`) ?? null;
  if (kind === "twap60") return result.candidates.find((c) => c.id.startsWith(`twap60:${arg}:`)) ?? null;
  if (kind === "best") return result.bestByFamily[arg as keyof PlanResult["bestByFamily"]] ?? null;
  throw new Error(`unknown protocol strategy ${role}`);
}

/** Adds the atlas-level inputs the cost model reads (gap and basis σ) and records the atlas as a source. */
export function withAtlasInputs(snap: LoadedSnapshot, doc: AtlasDoc): LoadedSnapshot {
  const gaps = doc.gapSigmaBps[snap.symbol];
  const basis = doc.basisSigmaBpsPerSqrtHour[snap.symbol];
  const atlasSource: SourceRef = {
    id: "slipway.atlas",
    status: Object.keys(snap.atlas).length ? "cached" : "unavailable",
    asOf: doc.generatedAt,
    detail: `${Object.keys(snap.atlas).length} key(s) for ${snap.symbol}, window ${new Date(doc.window.from).toISOString()} → ${new Date(doc.window.to).toISOString()}`,
  };
  return {
    ...snap,
    ...(gaps ? { gapSigmaBps: gaps } : {}),
    ...(basis !== undefined ? { basisSigmaBpsPerSqrtHour: basis } : {}),
    sources: [...snap.sources, atlasSource],
  };
}

export interface OrderOutcome extends EvalOrder {
  status: "registered" | "no_snapshot" | "planner_error";
  detail?: string;
  roles: Record<string, string | null>;
  plans: { strategyId: string; planHash: string; verdict: GateResult["verdict"]; entries: number }[];
}

export interface BatchManifest {
  batchId: string;
  modelVersion?: string; // core cost-model version stamped on every plan
  build?: BuildInfo | null; // code that registered the batch (repo + core commit)
  batchStart: number;
  protocolHash: string;
  seed: number;
  atlasGeneratedAt: number;
  pubkey: string;
  snapshotObject: string;
  snapshotSha256: string;
  plansObject: string;
  ledgerObject: string | null;
  registeredAt: number | null;
  entries: number;
  orders: OrderOutcome[];
}

export interface RunBatchOptions {
  protocol: Protocol;
  store: ObjectStore;
  ledger: LedgerStore;
  atlas: AtlasDoc;
  keys: CryptoKeyPair;
  pubkey: string;
  load: SnapshotLoader;
  now?: () => number;
  log?: (m: string) => void;
}

export const manifestName = (batchId: string) => `eval/batches/${batchId}.json`;
export const snapshotsName = (batchId: string) => `eval/snapshots/${batchId}.json.gz`;
export const plansName = (batchId: string) => `eval/plans/${batchId}.json.gz`;

export interface SnapshotBundle {
  batchId: string;
  protocolHash: string;
  atlasGeneratedAt: number;
  snapshots: Record<string, LoadedSnapshot>; // by symbol; a symbol's later orders under "SYM#<order>"
  errors: Record<string, string>;
  orderSnapshot?: Record<string, string>; // order index → key in `snapshots` (absent in batches before 12:50Z Oct 7)
}

/** Snapshot an order was planned on. */
export const snapshotFor = (b: SnapshotBundle, order: number, symbol: string): LoadedSnapshot | undefined =>
  b.snapshots[b.orderSnapshot?.[String(order)] ?? symbol];

export async function runBatch(o: RunBatchOptions): Promise<BatchManifest | null> {
  const clock = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const p = o.protocol;
  const batchStart = batchStartOf(p, clock());
  const batchId = batchIdOf(batchStart);
  if (await o.store.get(manifestName(batchId))) {
    log(`batch ${batchId} already registered`);
    return null;
  }
  const orders = drawBatch(p, batchStart);

  // Every order is planned, gated and signed right after its own snapshot loads, so live books are seconds old
  // even when planning is slow (a symbol drawn twice is loaded twice).
  const snapshots: Record<string, LoadedSnapshot> = {};
  const errors: Record<string, string> = {};
  const orderSnapshot: Record<string, string> = {};
  const outcomes: OrderOutcome[] = orders.map((order) => ({
    ...order,
    status: "registered",
    roles: {},
    plans: [],
  }));
  const signedPlans: { order: number; role: string[]; signed: SignedPlan }[] = [];
  for (const outcome of outcomes) {
    const symbol = outcome.symbol;
    const key = snapshots[symbol] || errors[symbol] ? `${symbol}#${outcome.i}` : symbol;
    orderSnapshot[String(outcome.i)] = key;
    let snap: LoadedSnapshot | null = null;
    try {
      snap = withAtlasInputs(await o.load(symbol, o.atlas.atlas), o.atlas);
      snapshots[key] = snap;
    } catch (e) {
      errors[key] = (e as Error).message;
    }
    {
      if (!snap) {
        outcome.status = "no_snapshot";
        outcome.detail = errors[key] ?? "snapshot unavailable";
        continue;
      }
      let result: PlanResult;
      try {
        result = planExecution(
          { symbol, side: outcome.side, notionalUsd: outcome.notionalUsd },
          p.profile,
          snap,
        );
      } catch (e) {
        outcome.status = "planner_error";
        outcome.detail = (e as Error).message;
        continue;
      }
      const byId = new Map<string, string[]>();
      for (const role of p.strategiesForecast) {
        const q = strategyForRole(result, role);
        outcome.roles[role] = q?.id ?? null;
        if (q) byId.set(q.id, [...(byId.get(q.id) ?? []), role]);
      }
      for (const [id, roles] of [...byId].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const plan = buildPlan(result, id);
        const gate = runGate({
          plan,
          snapshot: snap as MarketSnapshot,
          profile: p.profile,
          now: clock(),
          candidates: result.candidates,
        });
        signedPlans.push({
          order: outcome.i,
          role: roles,
          signed: await signPlan(plan, gate, o.keys, clock()),
        });
      }
    }
  }
  signedPlans.sort((a, b) => a.order - b.order);
  const bundle: SnapshotBundle = {
    batchId,
    protocolHash: PROTOCOL_HASH,
    atlasGeneratedAt: o.atlas.generatedAt,
    snapshots,
    errors,
    orderSnapshot,
  };
  const bundleJson = JSON.stringify(bundle);
  try {
    await o.store.put(snapshotsName(batchId), gzipSync(bundleJson), {
      ifGenerationMatch: "0",
      contentType: "application/gzip",
      cacheControl: "public, max-age=86400, immutable",
    });
  } catch (e) {
    // an earlier attempt for this window got as far as saving its inputs: never register the window twice
    if (e instanceof PreconditionFailed) {
      log(`batch ${batchId}: inputs already saved by an earlier attempt; window skipped`);
      return null;
    }
    throw e;
  }

  const registeredAt = clock();
  const bodies: ForecastBody[] = [];
  for (const sp of signedPlans) {
    const fs = forecastsFromPlan(sp.signed, "eval", registeredAt);
    bodies.push(...fs);
    (outcomes[sp.order] as OrderOutcome).plans.push({
      strategyId: sp.signed.plan.strategy.id,
      planHash: sp.signed.hash,
      verdict: sp.signed.gate.verdict,
      entries: fs.length,
    });
  }
  const appended = bodies.length ? await o.ledger.append("eval", bodies, registeredAt) : null;
  await o.store.put(plansName(batchId), gzipSync(JSON.stringify({ batchId, plans: signedPlans })), {
    ifGenerationMatch: "0",
    contentType: "application/gzip",
    cacheControl: "public, max-age=86400, immutable",
  });
  const manifest: BatchManifest = {
    batchId,
    modelVersion: MODEL_VERSION,
    build: BUILD,
    batchStart,
    protocolHash: PROTOCOL_HASH,
    seed: p.seed,
    atlasGeneratedAt: o.atlas.generatedAt,
    pubkey: o.pubkey,
    snapshotObject: snapshotsName(batchId),
    snapshotSha256: await sha256Hex(bundleJson),
    plansObject: plansName(batchId),
    ledgerObject: appended?.object ?? null,
    registeredAt: appended ? registeredAt : null,
    entries: bodies.length,
    orders: outcomes,
  };
  await o.store.put(manifestName(batchId), Buffer.from(JSON.stringify(manifest)), {
    ifGenerationMatch: "0",
    contentType: "application/json",
    cacheControl: "public, max-age=86400, immutable",
    gzip: true,
  });
  log(
    `batch ${batchId}: ${outcomes.filter((x) => x.status === "registered").length}/${orders.length} orders, ${signedPlans.length} plans, ${bodies.length} forecasts`,
  );
  return manifest;
}
