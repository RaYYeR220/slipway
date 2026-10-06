import { describe, expect, it } from "vitest";
import { BitgetApiError, HttpClient, HttpError, TokenBucket } from "../src/http.js";
import { BitgetRest, SourceError } from "../src/rest.js";
import { fakeSleep, fixture, restReplay } from "./helpers.js";

const quietRest = (fetch: ReturnType<typeof restReplay>, extra: Record<string, unknown> = {}) =>
  new BitgetRest({ fetch, sleep: fakeSleep(), random: () => 0.5, ...extra });

describe("TokenBucket", () => {
  it("allows a burst then spaces requests at the configured rate", () => {
    let t = 0;
    const b = new TokenBucket(10, 10, () => t);
    const waits = Array.from({ length: 12 }, () => b.reserve());
    expect(waits.slice(0, 10)).toEqual(Array(10).fill(0));
    expect(waits.slice(10)).toEqual([100, 200]);
    t = 1000;
    expect(b.reserve()).toBe(0);
  });
});

describe("HttpClient", () => {
  it("retries 5xx with jittered backoff, honours Retry-After on 429, then succeeds", async () => {
    const ok = fixture("rest/index-components.json").response.body;
    const script = [
      new Response("busy", { status: 503 }),
      new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      new Response(ok, { status: 200 }),
    ];
    const sleep = fakeSleep();
    const http = new HttpClient({
      fetch: async () => script.shift() as Response,
      sleep,
      random: () => 0.5,
      retries: 3,
    });
    const res = await http.getJson("https://api.bitget.com/x");
    expect(res.attempts).toBe(3);
    expect(sleep.log).toEqual([125, 1000]);
  });

  it("does not retry business errors and surfaces the Bitget code", async () => {
    const err = fixture("rest/error-unknown-symbol.json");
    let n = 0;
    const http = new HttpClient({
      fetch: async () => {
        n++;
        return new Response(err.response.body, { status: err.response.status });
      },
      sleep: fakeSleep(),
    });
    const e = await http.getJson("https://api.bitget.com/x").catch((x) => x);
    expect(e).toBeInstanceOf(BitgetApiError);
    expect(e).toMatchObject({ code: "40034", status: 400 });
    expect(n).toBe(1);
  });

  it("gives up after the retry budget on network errors", async () => {
    const http = new HttpClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: fakeSleep(),
      retries: 2,
    });
    const e = await http.getJson("https://api.bitget.com/x").catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.attempts).toBe(3);
    expect(e.message).toMatch(/fetch failed after 3 attempts/);
  });

  it("throttles the Reality group to 1 req/s while the global bucket still has burst", async () => {
    const t = 0;
    const sleep = fakeSleep();
    const body = fixture("rest/reality-states.json").response.body;
    const http = new HttpClient({
      fetch: async () => new Response(body),
      clock: () => t,
      sleep,
      groupRps: { reality: 1 },
    });
    await http.getJson("https://api.bitget.com/a", "reality");
    await http.getJson("https://api.bitget.com/b", "reality");
    await http.getJson("https://api.bitget.com/c");
    expect(sleep.log).toEqual([1000]);
  });
});

describe("BitgetRest against recorded responses", () => {
  it("builds the recorded URLs and returns parsed data with a live SourceRef", async () => {
    const fetch = restReplay();
    const rest = quietRest(fetch);
    const book = await rest.spotBook("nvda");
    expect(book.data.symbol).toBe("NVDA");
    expect(book.source).toMatchObject({ id: "bitget.spot.orderbook", status: "live", asOf: 1791262941135 });
    expect(book.source.detail).toMatch(/^GET \/api\/v2\/spot\/market\/orderbook \d+ ms$/);
    const depth = await rest.perpBook("NVDA");
    expect(depth.source.id).toBe("bitget.mix.orderbook");
    expect(fetch.calls).toEqual([
      "https://api.bitget.com/api/v2/spot/market/orderbook?symbol=RNVDAUSDT&type=step0&limit=150",
      "https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=NVDAUSDT&productType=USDT-FUTURES&limit=max",
    ]);
  });

  it("covers every endpoint family", async () => {
    const rest = quietRest(restReplay());
    const results = await Promise.all([
      rest.fills("rtoken", "NVDA", 20),
      rest.fills("perp", "NVDA", 20),
      rest.spotTicker("NVDA"),
      rest.perpTicker("NVDA"),
      rest.candles("rtoken", "NVDA", { interval: "1h", limit: 24 }),
      rest.candles("rtoken", "NVDA", { interval: "1h", limit: 24, history: true, endTime: 1 }),
      rest.candles("perp", "NVDA", { interval: "1h", limit: 24 }),
      rest.candles("perp", "NVDA", { interval: "1h", limit: 24, history: true, endTime: 1 }),
      rest.candles("rtoken", "NVDA", { interval: "1h", limit: 24, api: "v3" }),
      rest.candles("perp", "NVDA", { interval: "1h", limit: 24, api: "v3", history: true, endTime: 1 }),
      rest.spotSymbolInfo("NVDA"),
      rest.perpContract("NVDA"),
      rest.currentFunding("NVDA"),
      rest.funding("NVDA"),
      rest.fundingHistory("NVDA", 30),
      rest.indexComponents("NVDA"),
      rest.stockInfo("NVDA"),
      rest.marketStates(Date.UTC(2026, 9, 6)),
      rest.holidayCalendar(),
    ]);
    for (const r of results) expect(r.source.status).toBe("live");
    expect(results.map((r) => r.source.id)).toContain("bitget.reality.calendar");
    const funding = results[13]?.data;
    expect(funding).toEqual({
      rate: expect.any(Number),
      intervalHours: 8,
      nextFundingTime: expect.any(Number),
    });
  });

  it("throws SourceError with an unavailable SourceRef on business errors", async () => {
    const fetch = restReplay({
      "/api/v2/spot/market/orderbook": () => {
        const ex = fixture("rest/error-unknown-symbol.json");
        return new Response(ex.response.body, { status: ex.response.status });
      },
    });
    const rest = quietRest(fetch, { clock: () => 42 });
    const err = await rest.spotBook("NOSUCHSYM").catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.source).toMatchObject({
      id: "bitget.spot.orderbook",
      status: "unavailable",
      asOf: null,
      since: 42,
    });
    expect(err.source.detail).toMatch(/40034/);
  });

  it("reports unparseable payloads as unavailable instead of guessing", async () => {
    const fetch = restReplay({
      "/api/v3/market/index-components": () =>
        new Response(JSON.stringify({ code: "00000", data: { symbol: "NVDAUSDT" } })),
    });
    const err = await quietRest(fetch)
      .indexComponents("NVDA")
      .catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.source.detail).toMatch(/unparseable.*componentList/);
  });
});

describe("HttpClient body-read failures", () => {
  it("retries a timeout that fires while the body is being read", async () => {
    const ok = fixture("rest/index-components.json").response.body;
    let n = 0;
    const http = new HttpClient({
      sleep: fakeSleep(),
      random: () => 0,
      fetch: async () => {
        n++;
        if (n === 1) {
          const timeout = new DOMException("The operation timed out.", "TimeoutError");
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => Promise.reject(timeout),
          } as unknown as Response;
        }
        return new Response(ok);
      },
    });
    const res = await http.getJson("https://api.bitget.com/x");
    expect(res.attempts).toBe(2);
  });
});
