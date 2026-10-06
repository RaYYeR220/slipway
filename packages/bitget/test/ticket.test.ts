import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BitgetRestClient, loadConfig } from "@bitget-ai/bitget-agent-sdk";
import { MockServer } from "@bitget-ai/bitget-agent-sdk/testing";
import type { Slice } from "@slipway/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseContract, parseSpotSymbol } from "../src/parse.js";
import {
  bgcArgs,
  bgcCommand,
  buildTickets,
  type OrderTicket,
  SDK_VERSION,
  validatePlaceOrder,
} from "../src/ticket.js";
import { restBody } from "./helpers.js";

const rules = {
  rtoken: parseSpotSymbol(restBody("spot-symbols")).rules,
  perp: parseContract(restBody("perp-contracts")).rules,
};
const refPx = { rtoken: 239.46, perp: 239.645 };
const T0 = 1_791_263_000_000;

const slice = (s: Partial<Slice> & Pick<Slice, "venue" | "side" | "qty" | "type">): Slice => ({
  t: T0,
  session: "overnight",
  expectedBps: 5,
  ...s,
});

const schedule: Slice[] = [
  slice({ venue: "rtoken", side: "buy", qty: 10.123456, type: "market", limitPx: 239.523 }),
  slice({ venue: "rtoken", side: "buy", qty: 5, type: "limit", limitPx: 239.455, postOnly: true }),
  slice({ venue: "perp", side: "buy", qty: 20.005, type: "market", limitPx: 239.9 }),
  slice({
    venue: "perp",
    side: "sell",
    qty: 20,
    type: "market",
    limitPx: 239.111,
    t: T0 + 3_600_000,
    session: "regular",
  }),
  slice({ venue: "rtoken", side: "buy", qty: 4, type: "market" }),
];

describe("tickets via the official SDK dry-run", () => {
  it("produces the exact UTA v3 place-order requests, valid against the SDK catalog", async () => {
    const tickets = await buildTickets(schedule, {
      underlying: "NVDA",
      rules,
      refPx,
      clientOidPrefix: "slw1a2b3c4d",
    });
    expect(tickets.map((t) => [t.kind, t.request.body])).toEqual([
      [
        "ioc_limit",
        {
          category: "SPOT",
          symbol: "RNVDAUSDT",
          side: "buy",
          orderType: "limit",
          price: "239.53",
          qty: "10.1234",
          timeInForce: "ioc",
          clientOid: "slw1a2b3c4d00",
        },
      ],
      [
        "post_only",
        {
          category: "SPOT",
          symbol: "RNVDAUSDT",
          side: "buy",
          orderType: "limit",
          price: "239.45",
          qty: "5.0000",
          timeInForce: "post_only",
          clientOid: "slw1a2b3c4d01",
        },
      ],
      [
        "ioc_limit",
        {
          category: "USDT-FUTURES",
          symbol: "NVDAUSDT",
          side: "buy",
          orderType: "limit",
          price: "239.90",
          qty: "20.00",
          timeInForce: "ioc",
          clientOid: "slw1a2b3c4d02",
        },
      ],
      [
        "ioc_limit",
        {
          category: "USDT-FUTURES",
          symbol: "NVDAUSDT",
          side: "sell",
          orderType: "limit",
          price: "239.11",
          qty: "20.00",
          timeInForce: "ioc",
          reduceOnly: "yes",
          clientOid: "slw1a2b3c4d03",
        },
      ],
      [
        "market",
        {
          category: "SPOT",
          symbol: "RNVDAUSDT",
          side: "buy",
          orderType: "market",
          qty: "957.840000",
          clientOid: "slw1a2b3c4d04",
        },
      ],
    ]);
    for (const t of tickets) {
      expect(t.violations).toEqual([]);
      expect(t.request).toMatchObject({
        operationId: "placeOrder",
        method: "POST",
        path: "/api/v3/trade/place-order",
      });
      expect(t.sdkVersion).toBe(SDK_VERSION);
    }
    expect(tickets[4]?.notes.join(" ")).toMatch(/qty expressed in USDT/);
    expect(tickets[0]?.bgc).toBe(
      "bgc --read-only order --action place --category SPOT --symbol RNVDAUSDT --side buy --orderType limit --price 239.53 --qty 10.1234 --timeInForce ioc --clientOid slw1a2b3c4d00 --dry-run",
    );
  });

  it("caps uncapped market slices when asked, clamps to Bitget's price band and flags undersized orders", async () => {
    const tickets = await buildTickets(
      [
        slice({ venue: "perp", side: "buy", qty: 1, type: "market" }),
        slice({ venue: "perp", side: "buy", qty: 1, type: "market", limitPx: 260 }),
        slice({ venue: "rtoken", side: "sell", qty: 0.01, type: "market", limitPx: 239 }),
        slice({ venue: "perp", side: "sell", qty: 0.004, type: "limit", limitPx: 240 }),
      ],
      { underlying: "NVDA", rules, refPx, clientOidPrefix: "slwx", maxSlippageBps: 30 },
    );
    expect(tickets[0]?.request.body.price).toBe("240.37");
    expect(tickets[1]?.request.body.price).toBe("244.43");
    expect(tickets[1]?.notes.join(" ")).toMatch(/outside Bitget's 2% price band; clamped/);
    expect(tickets[2]?.violations).toEqual(["notional 2.39 USDT below minimum 10"]);
    expect(tickets[3]?.violations[0]).toMatch(/below minimum 0.01/);
  });

  it("uses posSide instead of reduceOnly in hedge mode", async () => {
    const t = await buildTickets(
      [
        slice({ venue: "perp", side: "buy", qty: 1, type: "market", limitPx: 240 }),
        slice({ venue: "perp", side: "sell", qty: 1, type: "market", limitPx: 239 }),
      ],
      { underlying: "NVDA", rules, refPx, clientOidPrefix: "h", positionMode: "hedge" },
    );
    expect(t.map((x) => [x.request.body.posSide, x.request.body.reduceOnly])).toEqual([
      ["long", undefined],
      ["long", undefined],
    ]);
  });

  it("validates bodies against the SDK's placeOrder schema", () => {
    expect(
      validatePlaceOrder({
        category: "SPOT",
        symbol: "X",
        side: "buy",
        orderType: "limit",
        qty: "1",
        price: "1",
        timeInForce: "gtc",
      }),
    ).toEqual([]);
    expect(
      validatePlaceOrder({
        category: "SPOT",
        symbol: "X",
        side: "long",
        orderType: "limit",
        qty: 1,
        leverage: "5",
      }),
    ).toEqual([
      "side=long not in [buy, sell]",
      "qty must be a string",
      "unknown field leverage",
      "limit orders need price and timeInForce",
    ]);
  });
});

describe("validated against Bitget's official SDK MockServer", () => {
  const mock = new MockServer();
  beforeAll(async () => {
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });

  it("accepts every ticket on the exact path, signed by the SDK client, and books it as sent", async () => {
    const tickets = await buildTickets(schedule, {
      underlying: "NVDA",
      rules,
      refPx,
      clientOidPrefix: "slwmock",
    });
    // Throwaway strings for the local mock only: it insists on the four ACCESS-* headers being present.
    const config = loadConfig({
      baseUrl: mock.baseUrl,
      apiKey: "mock",
      secretKey: "mock",
      passphrase: "mock",
      modules: "all",
    });
    const client = new BitgetRestClient(config);
    for (const t of tickets) {
      const res = await client.callOperation<{ orderId: string; clientOid: string }>(
        t.request.operationId,
        t.request.body,
      );
      expect(res.endpoint).toBe(`${t.request.method} ${t.request.path}`);
      expect(res.data.clientOid).toBe(t.clientOid);
      const booked = mock.getState().orders.get(res.data.orderId);
      expect(booked).toMatchObject({
        clientOid: t.clientOid,
        symbol: t.request.body.symbol,
        category: t.request.body.category,
        side: t.request.body.side,
        orderType: t.request.body.orderType,
        price: t.request.body.price ?? "0",
        status: "live",
      });
    }
    expect(mock.getState().orders.size).toBe(tickets.length);
  });

  it("runs a passive slice and its cancel-remaining-then-market fallback in order", async () => {
    const [passive, fallback] = await buildTickets(passiveThenCross, {
      underlying: "NVDA",
      rules,
      refPx,
      clientOidPrefix: "slwpass",
    });
    const client = new BitgetRestClient(
      loadConfig({
        baseUrl: mock.baseUrl,
        apiKey: "mock",
        secretKey: "mock",
        passphrase: "mock",
        modules: "all",
      }),
    );
    const placed = await client.callOperation<{ orderId: string }>("placeOrder", passive?.request.body);
    const cancel = fallback?.cancel as NonNullable<OrderTicket["cancel"]>;
    const cancelled = await client.callOperation(cancel.operationId, {
      ...cancel.body,
      orderId: placed.data.orderId,
    });
    expect(cancelled.endpoint).toBe("POST /api/v3/trade/cancel-order");
    expect(mock.getState().orders.get(placed.data.orderId)?.status).toBe("cancelled");
    const crossed = await client.callOperation<{ orderId: string }>("placeOrder", fallback?.request.body);
    expect(mock.getState().orders.get(crossed.data.orderId)).toMatchObject({
      orderType: "limit",
      status: "live",
    });
  });
});

const passiveThenCross: Slice[] = [
  slice({ venue: "rtoken", side: "buy", qty: 50, type: "limit", limitPx: 239.43, postOnly: true }),
  slice({
    venue: "rtoken",
    side: "buy",
    qty: 50,
    type: "market",
    limitPx: 239.8,
    conditional: true,
    t: T0 + 300_000,
  }),
];

describe("passive fallback, rotation legs and venue maxima", () => {
  it("renders the conditional slice as cancel-remaining-then-market, never as an unconditional second order", async () => {
    const [passive, fallback] = await buildTickets(passiveThenCross, {
      underlying: "NVDA",
      rules,
      refPx,
      clientOidPrefix: "slwp",
    });
    expect(passive).toMatchObject({ kind: "post_only", conditional: false });
    expect(fallback).toMatchObject({
      kind: "cancel_remaining_then_market",
      conditional: true,
      violations: [],
    });
    expect(fallback?.cancel).toMatchObject({
      operationId: "cancelOrder",
      method: "POST",
      path: "/api/v3/trade/cancel-order",
      body: { category: "SPOT", clientOid: "slwp00" },
      targetIndex: 0,
      bgc: "bgc --read-only order --action cancel --category SPOT --clientOid slwp00 --dry-run",
    });
    expect(fallback?.request.body).toMatchObject({ orderType: "limit", timeInForce: "ioc", price: "239.80" });
    expect(fallback?.notes[0]).toMatch(
      /^cancel-remaining-then-market: at t, cancel ticket #0 \(slwp00\); send this order only if/,
    );
    const orphan = await buildTickets([passiveThenCross[1] as Slice], {
      underlying: "NVDA",
      rules,
      refPx,
      clientOidPrefix: "o",
    });
    expect(orphan[0]?.violations).toEqual([
      "conditional slice has no preceding passive order on the same venue and side",
    ]);
  });

  it("marks rotate_out perp legs reduce-only even without an opening leg in the same schedule", async () => {
    const [t] = await buildTickets(
      [slice({ venue: "perp", side: "sell", qty: 3, type: "market", limitPx: 239, leg: "rotate_out" })],
      { underlying: "NVDA", rules, refPx, clientOidPrefix: "r" },
    );
    expect(t?.request.body.reduceOnly).toBe("yes");
  });

  it("refuses orders above Bitget's per-order maxima with the split needed", async () => {
    const tickets = await buildTickets(
      [
        slice({ venue: "perp", side: "buy", qty: 12_000, type: "market" }),
        slice({ venue: "perp", side: "buy", qty: 60_000, type: "market", limitPx: 240 }),
        slice({ venue: "rtoken", side: "buy", qty: 5_000, type: "market" }),
        slice({ venue: "rtoken", side: "buy", qty: 4_000, type: "market", limitPx: 240 }),
      ],
      { underlying: "NVDA", rules, refPx, clientOidPrefix: "big" },
    );
    expect(rules.perp).toMatchObject({ maxMarketQty: 9500, maxLimitQty: 52000 });
    expect(rules.rtoken).toMatchObject({ maxMarketNotional: 1_000_000, maxLimitNotional: 20_000_000 });
    expect(tickets[0]?.violations).toEqual([
      "qty 12000 exceeds Bitget's per-order maxMarketOrderQty 9500 for NVDAUSDT; split into at least 2 orders",
    ]);
    expect(tickets[1]?.violations).toEqual([
      "qty 60000 exceeds Bitget's per-order maxOrderQty 52000 for NVDAUSDT; split into at least 2 orders",
    ]);
    expect(tickets[2]?.violations).toEqual([
      "notional $1,197,300 exceeds Bitget's per-order maxMarketOrderValue $1,000,000 for RNVDAUSDT; split into at least 2 orders",
    ]);
    expect(tickets[3]?.violations).toEqual([]);
  });
});

describe("bgc command equivalence", () => {
  const cli = join(
    dirname(createRequire(import.meta.url).resolve("@bitget-ai/bitget-agent-cli/package.json")),
    "lib",
    "index.js",
  );

  it("running the printed bgc command yields the identical would-send body", async () => {
    const tickets = await buildTickets([schedule[3] as Slice, schedule[4] as Slice], {
      underlying: "NVDA",
      rules,
      refPx,
      clientOidPrefix: "slwbgc",
    });
    for (const t of tickets) {
      const { stdout } = await promisify(execFile)(process.execPath, [cli, ...bgcArgs(t.request.body)], {
        env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
        timeout: 30_000,
      });
      const out = JSON.parse(stdout) as {
        data: { dryRun: boolean; path: string; wouldSend: Record<string, string> };
      };
      expect(out.data.dryRun).toBe(true);
      expect(out.data.path).toBe(t.request.path);
      expect(out.data.wouldSend).toEqual(t.request.body);
      expect(bgcCommand(t.request.body)).toBe(["bgc", ...bgcArgs(t.request.body)].join(" "));
    }
  }, 60_000);
});
