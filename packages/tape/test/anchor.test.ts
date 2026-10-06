import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ForecastBody, ForecastEntry } from "@slipway/core";
import { concatHex, type Hex, keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anchorClient, FORECAST_ANCHOR_ABI, readAnchors } from "../src/anchor/contract.js";
import { type AnchorFile, publishAnchorConfig, runAnchorJob, windowLeaves } from "../src/anchor/job.js";
import { leafOf, merkleProof, merkleRoot, verifyProof } from "../src/anchor/merkle.js";
import { PROTOCOL_HASH } from "../src/eval/protocol.js";
import { ObjectLedgerStore } from "../src/ledger.js";
import { FsTapeSource } from "../src/source.js";
import { FsObjectStore } from "../src/store.js";
import { runVerify } from "../src/verify.js";
import { fix, readJson, tempDir } from "./helpers.js";

const recorded = readJson<ForecastEntry[]>("eval", "entries.json");
const hashes = recorded.map((e) => e.hash);

describe("Merkle tree (ForecastAnchor-compatible)", () => {
  it("hashes leaves and sorted pairs like the contract", () => {
    const [a, b] = hashes as [string, string];
    const la = keccak256(`0x${a}`);
    const lb = keccak256(`0x${b}`);
    expect(leafOf(a)).toBe(la);
    expect(merkleRoot([a, b])).toBe(
      la < lb ? keccak256(concatHex([la, lb])) : keccak256(concatHex([lb, la])),
    );
    expect(merkleRoot([a])).toBe(la);
    expect(() => merkleRoot([])).toThrow();
    expect(() => leafOf("not-a-hash")).toThrow();
  });

  it("proves every leaf of odd and even trees and rejects foreign leaves", () => {
    for (const n of [1, 2, 3, 5, 8, 13, recorded.length]) {
      const xs = hashes.slice(0, n);
      const root = merkleRoot(xs);
      xs.forEach((h, i) => {
        expect(verifyProof(root, h, merkleProof(xs, i))).toBe(true);
      });
      if (n < recorded.length) expect(verifyProof(root, hashes[n] as string, merkleProof(xs, 0))).toBe(false);
    }
  });
});

const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ANVIL_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const RPC = `http://127.0.0.1:${PORT}`;

describe.runIf(process.env.SLIPWAY_ANVIL === "1")("anchoring on an Arbitrum One fork (anvil)", () => {
  let anvil: ChildProcess;
  let contract: Hex;
  const genesis = Math.floor(Date.now() / 1000) - 3600;

  beforeAll(async () => {
    anvil = spawn(
      "anvil",
      [
        "--fork-url",
        "https://arb1.arbitrum.io/rpc",
        "--port",
        String(PORT),
        "--chain-id",
        "31337",
        "--silent",
      ],
      {
        stdio: "ignore",
      },
    );
    for (let i = 0; i < 60; i++) {
      try {
        if ((await anchorClient(RPC).getChainId()) === 31337) break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    execFileSync(
      "forge",
      ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", RPC, "--broadcast", "--private-key", ANVIL_PK],
      {
        cwd: CONTRACTS,
        env: {
          ...process.env,
          ANCHORER: ANVIL_ADDR,
          PROTOCOL_HASH: `0x${PROTOCOL_HASH}`,
          GENESIS_TS: String(genesis),
        },
        stdio: "pipe",
      },
    );
    const run = JSON.parse(readFileSync(`${CONTRACTS}broadcast/Deploy.s.sol/31337/run-latest.json`, "utf8"));
    contract = run.transactions[0].contractAddress as Hex;
  }, 120_000);

  afterAll(() => {
    if (process.platform === "win32" && anvil?.pid)
      execFileSync("taskkill", ["/PID", String(anvil.pid), "/T", "/F"], { stdio: "ignore" });
    else anvil?.kill();
  });

  it("anchors contiguous windows of ledger entries; the contract verifies their proofs", async () => {
    const store = new FsObjectStore(tempDir());
    const ledger = new ObjectLedgerStore(store);
    const t1 = Date.now() - 1_800_000;
    const body = (e: ForecastEntry, t: number): ForecastBody => {
      const { hash: _h, prevHash: _p, ...b } = e;
      return { ...b, registeredAt: t };
    };
    await ledger.append(
      "eval",
      recorded.slice(0, 25).map((e) => body(e, t1)),
      t1,
    );
    const cfg = { rpc: RPC, contract, privateKey: ANVIL_PK };
    const state0 = await readAnchors(anchorClient(RPC), contract);
    expect(state0.protocolHash).toBe(`0x${PROTOCOL_HASH}`);
    expect(state0.genesisTs).toBe(genesis);

    const a0 = (await runAnchorJob(store, cfg, Date.now())) as AnchorFile;
    expect(a0.index).toBe(0);
    expect(a0.fromTs).toBe(genesis);
    expect(a0.count).toBe(25);
    expect(a0.leaves.map((l) => l.hash)).toEqual((await ledger.read("eval")).entries.map((e) => e.hash));
    const client = anchorClient(RPC);
    for (const i of [0, 7, 24]) {
      const ok = await client.readContract({
        address: contract,
        abi: FORECAST_ANCHOR_ABI,
        functionName: "verify",
        args: [
          0n,
          `0x${a0.leaves[i]?.hash}` as Hex,
          merkleProof(
            a0.leaves.map((l) => l.hash),
            i,
          ),
        ],
      });
      expect(ok).toBe(true);
    }
    const forged = await client.readContract({
      address: contract,
      abi: FORECAST_ANCHOR_ABI,
      functionName: "verify",
      args: [
        0n,
        `0x${"ab".repeat(32)}` as Hex,
        merkleProof(
          a0.leaves.map((l) => l.hash),
          0,
        ),
      ],
    });
    expect(forged).toBe(false);

    // nothing new → no transaction; new entries → next window starts where the last ended
    expect(await runAnchorJob(store, cfg, Date.now())).toBeNull();
    await client.request({ method: "evm_increaseTime" as never, params: [900] as never });
    await client.request({ method: "evm_mine" as never, params: [] as never });
    const t2 = Date.now() + 300_000;
    await ledger.append(
      "eval",
      recorded.slice(25, 31).map((e) => body(e, t2)),
      t2,
    );
    const later = Date.now() + 900_000;
    const a1 = (await runAnchorJob(store, cfg, later)) as AnchorFile;
    expect(a1.index).toBe(1);
    expect(a1.fromTs).toBe(a0.toTs);
    expect(a1.count).toBe(6);
    expect(await windowLeaves(store, a1.fromTs, a1.toTs)).toEqual(a1.leaves);

    // a lost anchors/<i>.json is rebuilt from the chain and the ledger
    await store.delete("anchors/1.json");
    await runAnchorJob(store, cfg, later);
    const got = await store.get("anchors/1.json");
    expect(got).not.toBeNull();
    const rebuilt = JSON.parse(String(got?.data)) as AnchorFile;
    expect(rebuilt.root).toBe(a1.root);
    expect(rebuilt.txHash).toBe(a1.txHash);

    // the public verifier agrees
    await publishAnchorConfig(store, cfg, RPC);
    const checks = await runVerify({ store, source: new FsTapeSource(fix("tape")), sample: 3, seed: 7 });
    expect(checks.find((c) => c.name === "anchors")?.status).toBe("PASS");
    expect(checks.find((c) => c.name === "protocol on-chain")?.status).toBe("PASS");
    expect(checks.find((c) => c.name === "negative control")?.status).toBe("PASS");
    expect(checks.filter((c) => c.status === "FAIL")).toEqual([]);
  }, 180_000);
});
