import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Desk } from "@slipway/agent";
import { describe, expect, it } from "vitest";
import { recordedDeskOptions } from "../../agent/test/support/desk.js";
import { createSlipwayMcpServer } from "../src/server.js";

const SKILL = readFileSync(
  fileURLToPath(new URL("../../../skills/slipway/SKILL.md", import.meta.url)),
  "utf8",
);

describe("skills/slipway/SKILL.md", () => {
  it("uses Bitget's skill frontmatter (name, description, metadata, license)", () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL.replace(/\r\n/g, "\n"))?.[1] ?? "";
    expect(fm).toMatch(/^name: slipway$/m);
    expect(fm).toMatch(/^description: >$/m);
    expect(fm).toMatch(/^metadata:\n {2}version: /m);
    expect(fm).toMatch(/^license: MIT$/m);
  });

  it("names exactly the tools the server exposes and every gate code", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createSlipwayMcpServer(new Desk(recordedDeskOptions() as never));
    await server.connect(b);
    const client = new Client({ name: "skill-check", version: "0" });
    await client.connect(a);
    const served = (await client.listTools()).tools.map((t) => t.name).sort();
    const documented = [...SKILL.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(served);
    for (const code of [
      "COST_CAP",
      "BOOK_EXHAUSTED",
      "PARTICIPATION",
      "VENUE_CLOSED",
      "EVENT_WINDOW",
      "PRICE_INTEGRITY",
      "DATA_STALE",
      "PROFILE",
      "SOURCE_MISSING",
    ])
      expect(SKILL).toContain(`\`${code}\``);
    await client.close();
  });
});
