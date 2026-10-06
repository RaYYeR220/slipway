// Hits the real endpoints. Run: LIVE=1 pnpm vitest run packages/bitget/test/live.test.ts
import type { Slice } from "@slipway/core";
import { afterAll, describe, expect, it } from "vitest";
import { BitgetDataMcp } from "../src/bitget-mcp.js";
import { SourceCache } from "../src/cache.js";
import { BitgetRest } from "../src/rest.js";
import { SignalMcp } from "../src/signal-mcp.js";
import { loadMarketSnapshot } from "../src/snapshot.js";
import { buildTickets } from "../src/ticket.js";
import type { Optional } from "../src/types.js";
import { BitgetPublicWs, type WsEvent } from "../src/ws.js";

const SYM = process.env.SYM ?? "NVDA";
const report: string[] = [];
const row = (r: Pick<Optional<unknown>, "source" | "latencyMs">) =>
  report.push(
    `${r.source.id.padEnd(48)} ${r.source.status.padEnd(11)} ${String(r.latencyMs).padStart(6)} ms  ${r.source.detail ?? ""}`,
  );

describe.skipIf(!process.env.LIVE)("live endpoints", () => {
  const cache = new SourceCache();
  const rest = new BitgetRest();
  const dataMcp = new BitgetDataMcp({ cache });
  const signal = new SignalMcp({ cache });

  afterAll(async () => {
    await Promise.all([dataMcp.client.close(), signal.client.close()]);
    console.log(`\n${report.join("\n")}\n`);
  });

  it("Bitget public REST: every endpoint family answers and parses", async () => {
    const calls = await Promise.all([
      rest.spotBook(SYM),
      rest.perpBook(SYM),
      rest.fills("rtoken", SYM, 20),
      rest.fills("perp", SYM, 20),
      rest.spotTicker(SYM),
      rest.perpTicker(SYM),
      rest.candles("rtoken", SYM, { interval: "1h", limit: 24 }),
      rest.candles("perp", SYM, {
        interval: "1h",
        limit: 24,
        history: true,
        endTime: Date.now() - 3_600_000,
      }),
      rest.candles("perp", SYM, { interval: "4h", limit: 10, api: "v3" }),
      rest.spotSymbolInfo(SYM),
      rest.perpContract(SYM),
      rest.currentFunding(SYM),
      rest.fundingHistory(SYM, 10),
      rest.indexComponents(SYM),
      rest.stockInfo(SYM),
      rest.marketStates(),
      rest.holidayCalendar(),
    ]);
    for (const c of calls) {
      row(c);
      expect(c.source.status).toBe("live");
    }
  }, 60_000);

  it("public WS delivers a perp book and ticker", async () => {
    const ws = new BitgetPublicWs();
    const got: WsEvent[] = [];
    const t0 = performance.now();
    const done = new Promise<void>((resolve) => {
      ws.onEvent((e) => {
        got.push(e);
        if (got.some((x) => x.type === "book") && got.some((x) => x.type === "ticker")) resolve();
      });
    });
    ws.subscribe([
      { venue: "perp", underlying: SYM, channel: "books15" },
      { venue: "perp", underlying: SYM, channel: "ticker" },
    ]);
    ws.start();
    await done;
    ws.stop();
    report.push(
      `${"bitget.ws.public books15+ticker".padEnd(48)} live        ${String(Math.round(performance.now() - t0)).padStart(6)} ms  first book + ticker after connect`,
    );
  }, 30_000);

  it("bitget-mcp: guide discovers entries; do_query never throws", async () => {
    const t0 = performance.now();
    const guide = await dataMcp.guide("equity");
    row(guide);
    expect(guide.data?.length).toBeGreaterThan(0);
    const now = Date.now();
    const results = await Promise.all([
      dataMcp.equityQuote(SYM),
      dataMcp.earnings(SYM, now - 86_400_000, now + 30 * 86_400_000),
      dataMcp.corporateActions(SYM, now - 30 * 86_400_000, now + 90 * 86_400_000),
      dataMcp.marketFearGreed(),
      dataMcp.news("stocks", { pageSize: 5 }),
    ]);
    for (const r of results) {
      row(r);
      expect(["live", "cached", "unavailable"]).toContain(r.source.status);
      if (r.source.status === "unavailable") expect(r.data).toBeNull();
    }
    report.push(
      `bitget-mcp total ${Math.round(performance.now() - t0)} ms (server ${dataMcp.client.serverInfo?.version ?? "?"})`,
    );
  }, 60_000);

  it("signal MCP: ccxt tools answer; indicators are audited", async () => {
    const [price, audit] = await Promise.all([signal.perpPrice(SYM), signal.bollingerAudit(SYM)]);
    row(price);
    row(audit);
    expect(price.data?.price).toBeGreaterThan(0);
    if (audit.data)
      report.push(`  bollinger flags: ${audit.data.flags.map((f) => f.code).join(", ") || "none"}`);
  }, 60_000);

  it("snapshot + SDK dry-run tickets from live data", async () => {
    const t0 = performance.now();
    const snap = await loadMarketSnapshot(SYM, { cache, rest, dataMcp, signal, optionalBudgetMs: 3_000 });
    report.push(
      `snapshot ${SYM} in ${Math.round(performance.now() - t0)} ms; integrity: ${snap.integrity.map((f) => f.code).join(", ")}`,
    );
    for (const s of snap.sources)
      report.push(`  ${s.id.padEnd(46)} ${s.status.padEnd(11)} ${s.detail ?? ""}`);
    expect(snap.books.perp?.bids.length).toBeGreaterThan(0);
    const ask = snap.books.perp?.asks[0]?.px as number;
    const slices: Slice[] = [
      {
        t: Date.now(),
        venue: "perp",
        side: "buy",
        qty: 1,
        type: "market",
        limitPx: ask * 1.001,
        session: "regular",
        expectedBps: 0,
      },
    ];
    const [ticket] = await buildTickets(slices, {
      underlying: SYM,
      rules: snap.rules,
      refPx: { perp: ask },
      clientOidPrefix: "slwlive",
    });
    expect(ticket?.violations).toEqual([]);
    report.push(`  ticket: ${ticket?.bgc}`);
  }, 90_000);
});
