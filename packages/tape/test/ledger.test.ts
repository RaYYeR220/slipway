import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ForecastBody, type ForecastEntry, GENESIS_PREV, verifyChain } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { checkChain, FsLedgerStore, ObjectLedgerStore, objectName } from "../src/ledger.js";
import { FsObjectStore } from "../src/store.js";
import { readJson, tempDir } from "./helpers.js";

// real eval forecasts (one MSTR order of a dry-run batch), re-registered at test time
const recorded = readJson<ForecastEntry[]>("eval", "entries.json");
const bodies = (n: number, registeredAt: number): ForecastBody[] =>
  recorded.slice(0, n).map(({ hash: _h, prevHash: _p, ...b }) => ({ ...b, registeredAt }));

describe("ledger store", () => {
  it("appends write-once objects that chain from genesis and verify", async () => {
    const dir = tempDir();
    const ledger = new FsLedgerStore(dir);
    const t = Date.now();
    const a = await ledger.append("eval", bodies(5, t), t);
    const b = await ledger.append("eval", bodies(7, t + 1), t + 1);
    expect(a.object).toBe(objectName("eval", t, a.entries.at(-1)?.hash ?? ""));
    expect(a.object).toMatch(/^ledger\/eval\/\d{4}-\d{2}-\d{2}\/\d+-[0-9a-f]{16}\.jsonl$/);
    expect(b.entries[0]?.prevHash).toBe(a.head.head);
    const read = await ledger.read("eval");
    expect(read.entries.length).toBe(12);
    expect(read.orphans).toEqual([]);
    expect(await verifyChain(read.entries, GENESIS_PREV)).toBe(-1);
    expect((await checkChain(read)).ok).toBe(true);
    expect((await ledger.head("trader")).count).toBe(0);
    expect((await ledger.read("trader")).entries).toEqual([]);
  });

  it("never forks: a writer whose head is stale retries on top of the new head", async () => {
    const dir = tempDir();
    const store = new FsObjectStore(dir);
    const t = Date.now();
    const slow = new ObjectLedgerStore(store);
    const fast = new FsLedgerStore(dir);
    // the slow writer reads the head, then the fast one commits before the slow one swaps the head
    const origGet = store.get.bind(store);
    let interleaved = false;
    store.get = async (name: string) => {
      const r = await origGet(name);
      if (name.endsWith("head.json") && !interleaved) {
        interleaved = true;
        await fast.append("eval", bodies(2, t), t);
      }
      return r;
    };
    const res = await slow.append("eval", bodies(3, t + 1), t + 1);
    store.get = origGet;
    const read = await fast.read("eval");
    expect(read.entries.length).toBe(5);
    expect(read.orphans).toEqual([]);
    expect(res.entries[0]?.prevHash).toBe(read.entries[1]?.hash);
    expect((await checkChain(read)).ok).toBe(true);
  });

  it("detects a tampered entry and a rewritten head", async () => {
    const dir = tempDir();
    const ledger = new FsLedgerStore(dir);
    const t = Date.now();
    const a = await ledger.append("eval", bodies(4, t), t);
    const file = join(dir, ...a.object.split("/"));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const forged = JSON.parse(lines[1] as string) as ForecastEntry;
    forged.predicted = { ...forged.predicted, p50: forged.predicted.p50 - 1 };
    lines[1] = JSON.stringify(forged);
    writeFileSync(file, `${lines.join("\n")}\n`);
    const check = await checkChain(await ledger.read("eval"));
    expect(check.ok).toBe(false);
    expect(check.firstBad).toBe(1);
  });

  it("rejects late registrations and entries of the other origin", async () => {
    const ledger = new FsLedgerStore(tempDir());
    const t = Date.now();
    await expect(ledger.append("eval", bodies(1, t - 120_000), t)).rejects.toThrow(/registeredAt/);
    await expect(ledger.append("trader", bodies(1, t), t)).rejects.toThrow(/origin eval/);
    await ledger.append("eval", bodies(1, t), t);
    await expect(ledger.append("eval", bodies(1, t - 1), t)).rejects.toThrow(/precedes the chain tip/);
  });
});
