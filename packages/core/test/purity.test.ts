import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ f, text: readFileSync(`${srcDir}${f}`, "utf8") }));

describe("core purity", () => {
  it("imports nothing but sibling modules (zero runtime deps, no node: builtins)", () => {
    for (const { f, text } of sources) {
      for (const m of text.matchAll(/from\s+"([^"]+)"/g))
        expect(`${f}: ${m[1]}`).toMatch(/: \.\/[a-z]+\.js$/);
    }
  });

  it("never reads the clock, randomness or the network", () => {
    for (const { f, text } of sources) {
      expect(
        `${f}: ${/Date\.now|new Date\(\)|Math\.random|performance\.now|fetch\(|process\./.test(text)}`,
      ).toBe(`${f}: false`);
    }
  });

  it("declares no dependencies", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe("public API", () => {
  it("exports the engine from the barrel", () => {
    for (const name of [
      "sessionAt",
      "nextSessionStart",
      "transitions",
      "hourOfWeek",
      "bookFromBitget",
      "walk",
      "depthWithin",
      "qtyForNotional",
      "estimateResilience",
      "buildLiquidityStats",
      "priceSchedule",
      "planExecution",
      "buildPlan",
      "runGate",
      "largestQtyUnderCap",
      "signPlan",
      "verifySignedPlan",
      "assertTicketable",
      "canonicalJson",
      "atlasKey",
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
