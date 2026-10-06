// Anchor job (every 30 min): Merkle root over every ledger entry (both chains) registered in the next contiguous
// window [fromTs, toTs) → ForecastAnchor.anchor on Arbitrum One, then anchors/<index>.json with the leaves in order
// so anyone can rebuild every proof. Empty windows are not anchored; the next window simply starts earlier.
import { createWalletClient, type Hex, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { CHAINS, type Chain, chainIndex, loadObject, type ObjectSummary } from "../ledger.js";
import { type ObjectStore, PreconditionFailed } from "../store.js";
import { anchorClient, FORECAST_ANCHOR_ABI, type OnChainAnchor, readAnchors } from "./contract.js";
import { merkleRoot } from "./merkle.js";

export const LEAF_ORDER = "eval chain entries in chain order, then trader chain entries in chain order";
/** A window closes this long before "now" so commits in flight (≤ 60 s registration lag) are never missed. */
export const CLOSE_MARGIN_SEC = 120;

export interface AnchorFile {
  index: number;
  chainId: number;
  contract: Hex;
  root: Hex;
  count: number;
  fromTs: number;
  toTs: number;
  txHash: Hex | null;
  blockNumber: number | null;
  anchoredAt: number;
  leafOrder: string;
  leaves: { chain: Chain; hash: string }[];
}

export interface AnchorConfig {
  rpc: string;
  contract: Hex;
  privateKey: Hex;
}

export const anchorName = (i: number) => `anchors/${i}.json`;

export async function windowLeaves(
  store: ObjectStore,
  fromTs: number,
  toTs: number,
  cache: Map<string, ObjectSummary> = new Map(),
): Promise<{ chain: Chain; hash: string }[]> {
  const out: { chain: Chain; hash: string }[] = [];
  for (const chain of CHAINS) {
    const { objects } = await chainIndex(store, chain, cache);
    for (const o of objects) {
      if (o.maxRegisteredAt < fromTs * 1000 || o.minRegisteredAt >= toTs * 1000) continue;
      for (const e of await loadObject(store, o.name))
        if (e.registeredAt >= fromTs * 1000 && e.registeredAt < toTs * 1000)
          out.push({ chain, hash: e.hash });
    }
  }
  return out;
}

async function writeAnchorFile(store: ObjectStore, a: AnchorFile) {
  try {
    await store.put(anchorName(a.index), Buffer.from(JSON.stringify(a)), {
      ifGenerationMatch: "0",
      contentType: "application/json",
      cacheControl: "public, max-age=3600",
      gzip: true,
    });
  } catch (e) {
    if (!(e instanceof PreconditionFailed)) throw e;
  }
}

/** The Anchored event of one index, searched backwards in RPC-sized block ranges (public RPCs cap getLogs spans). */
async function findAnchoredLog(
  client: PublicClient,
  address: Hex,
  index: number,
  chunk = 500_000n,
  maxChunks = 40,
) {
  let to = await client.getBlockNumber();
  for (let k = 0; k < maxChunks && to > 0n; k++) {
    const from = to > chunk ? to - chunk + 1n : 0n;
    const logs = await client.getContractEvents({
      address,
      abi: FORECAST_ANCHOR_ABI,
      eventName: "Anchored",
      args: { index: BigInt(index) },
      fromBlock: from,
      toBlock: to,
    });
    if (logs[0]) return logs[0];
    to = from - 1n;
  }
  return null;
}

/** Re-creates anchors/<i>.json for on-chain anchors whose file is missing (e.g. the upload failed after the tx). */
async function repairFiles(
  store: ObjectStore,
  client: PublicClient,
  cfg: AnchorConfig,
  anchors: OnChainAnchor[],
  cache: Map<string, ObjectSummary>,
) {
  const chainId = await client.getChainId();
  for (const a of anchors) {
    if (await store.get(anchorName(a.index))) continue;
    const leaves = await windowLeaves(store, a.fromTs, a.toTs, cache);
    if (leaves.length !== a.count || merkleRoot(leaves.map((l) => l.hash)) !== a.root)
      throw new Error(`on-chain anchor ${a.index} does not match the ledger window ${a.fromTs}..${a.toTs}`);
    const log = await findAnchoredLog(client, cfg.contract, a.index);
    await writeAnchorFile(store, {
      index: a.index,
      chainId,
      contract: cfg.contract,
      root: a.root,
      count: a.count,
      fromTs: a.fromTs,
      toTs: a.toTs,
      txHash: log?.transactionHash ?? null,
      blockNumber: log ? Number(log.blockNumber) : null,
      anchoredAt: a.anchoredAt,
      leafOrder: LEAF_ORDER,
      leaves,
    });
  }
}

export async function runAnchorJob(
  store: ObjectStore,
  cfg: AnchorConfig,
  now: number,
  log: (m: string) => void = () => {},
  cache: Map<string, ObjectSummary> = new Map(),
): Promise<AnchorFile | null> {
  const client = anchorClient(cfg.rpc);
  const chainId = await client.getChainId();
  const state = await readAnchors(client, cfg.contract);
  await repairFiles(store, client, cfg, state.anchors, cache);
  const last = state.anchors.at(-1);
  const fromTs = last ? last.toTs : state.genesisTs;
  const block = await client.getBlock();
  const toTs = Math.min(Math.floor(now / 1000) - CLOSE_MARGIN_SEC, Number(block.timestamp));
  if (toTs <= fromTs) {
    log(`anchor: window ${fromTs}..${toTs} not closed yet`);
    return null;
  }
  const leaves = await windowLeaves(store, fromTs, toTs, cache);
  if (leaves.length === 0) {
    log(`anchor: no entries registered in ${fromTs}..${toTs}; window stays open`);
    return null;
  }
  const root = merkleRoot(leaves.map((l) => l.hash));
  const account = privateKeyToAccount(cfg.privateKey);
  const wallet = createWalletClient({
    account,
    chain: { ...arbitrum, id: chainId },
    transport: http(cfg.rpc),
  });
  const args = [root, BigInt(leaves.length), BigInt(fromTs), BigInt(toTs)] as const;
  const { request } = await client.simulateContract({
    account,
    address: cfg.contract,
    abi: FORECAST_ANCHOR_ABI,
    functionName: "anchor",
    args,
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`anchor tx ${txHash} reverted`);
  const mined = await client.getBlock({ blockNumber: receipt.blockNumber });
  const file: AnchorFile = {
    index: state.anchors.length,
    chainId,
    contract: cfg.contract,
    root,
    count: leaves.length,
    fromTs,
    toTs,
    txHash,
    blockNumber: Number(receipt.blockNumber),
    anchoredAt: Number(mined.timestamp),
    leafOrder: LEAF_ORDER,
    leaves,
  };
  await writeAnchorFile(store, file);
  log(`anchor ${file.index}: ${leaves.length} entries ${fromTs}..${toTs} root ${root} tx ${txHash}`);
  return file;
}

/** Public pointer for verifiers: which contract on which chain, readable through which RPC. */
export async function publishAnchorConfig(
  store: ObjectStore,
  cfg: AnchorConfig,
  publicRpc: string,
): Promise<void> {
  const client = anchorClient(cfg.rpc);
  const s = await readAnchors(client, cfg.contract);
  const body = {
    chainId: await client.getChainId(),
    contract: cfg.contract,
    rpc: publicRpc,
    genesisTs: s.genesisTs,
    protocolHash: s.protocolHash,
    anchorer: s.anchorer,
  };
  await store.put("anchors/config.json", Buffer.from(JSON.stringify(body)), {
    contentType: "application/json",
    cacheControl: "no-cache, max-age=30",
  });
}
