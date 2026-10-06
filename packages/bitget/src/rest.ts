// Typed keyless client for Bitget public REST (spot rTokens, USDT-M stock perps, Reality reference data).
// Every method returns parsed data plus a SourceRef; failures throw SourceError carrying an "unavailable" SourceRef.
import type { Book, FundingInfo, SourceRef, SymbolSessions, Venue } from "@slipway/core";
import { ref } from "./cache.js";
import { HttpClient, type HttpClientOptions, type HttpResult } from "./http.js";
import {
  parseCalendar,
  parseCandles,
  parseContract,
  parseCurrentFunding,
  parseFills,
  parseFundingHistory,
  parseIndexComponents,
  parsePerpTicker,
  parseRestBook,
  parseSpotSymbol,
  parseSpotTicker,
  parseStates,
  parseStockInfo,
} from "./parse.js";
import { perpSymbol, spotSymbol } from "./symbols.js";
import type {
  Candle,
  CandleInterval,
  CurrentFunding,
  FundingPoint,
  IndexComponent,
  MarketStates,
  PerpContractInfo,
  PerpTicker,
  RealityCalendar,
  Sourced,
  SpotSymbolInfo,
  SpotTicker,
  Trade,
} from "./types.js";

export const BITGET_REST = "https://api.bitget.com";

export class SourceError extends Error {
  constructor(
    readonly source: SourceRef,
    readonly cause?: unknown,
  ) {
    super(`${source.id} unavailable: ${source.detail ?? "unknown error"}`);
    this.name = "SourceError";
  }
}

export interface BitgetRestOptions extends HttpClientOptions {
  baseUrl?: string;
}

const V2_GRANULARITY: Record<Venue, Record<CandleInterval, string>> = {
  rtoken: {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1day",
  },
  perp: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D" },
};
const V3_INTERVAL: Record<CandleInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

export interface CandleQuery {
  interval: CandleInterval;
  limit?: number;
  startTime?: number;
  endTime?: number;
  /** Use the history-candles endpoint (older data, paged by endTime). */
  history?: boolean;
  /** v3 UTA market endpoints (`/api/v3/market/candles`) instead of v2. */
  api?: "v2" | "v3";
}

const qs = (params: Record<string, string | number | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export class BitgetRest {
  readonly http: HttpClient;
  private readonly base: string;
  private readonly clock: () => number;

  constructor(opts: BitgetRestOptions = {}) {
    this.base = opts.baseUrl ?? BITGET_REST;
    this.clock = opts.clock ?? Date.now;
    this.http = new HttpClient({ groupRps: { reality: 1 }, ...opts });
  }

  private async get<T>(
    id: string,
    path: string,
    parse: (body: unknown, res: HttpResult) => T,
    asOf: (data: T, res: HttpResult) => number | null,
    group?: string,
  ): Promise<Sourced<T>> {
    const url = `${this.base}${path}`;
    const endpoint = `GET ${path.split("?")[0]}`;
    let res: HttpResult;
    try {
      res = await this.http.getJson(url, group);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SourceError(
        { ...ref(id, "unavailable", null, `${endpoint}: ${msg}`), since: this.clock() },
        err,
      );
    }
    let data: T;
    try {
      data = parse(res.body, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SourceError(
        { ...ref(id, "unavailable", null, `${endpoint}: unparseable (${msg})`), since: this.clock() },
        err,
      );
    }
    return {
      data,
      source: ref(id, "live", asOf(data, res), `${endpoint} ${res.latencyMs} ms`),
      latencyMs: res.latencyMs,
    };
  }

  private requestTime = (body: unknown, res: HttpResult): number => {
    const t = (body as { requestTime?: unknown }).requestTime;
    return typeof t === "number" ? t : res.receivedAt;
  };

  spotBook(underlying: string, limit = 150): Promise<Sourced<Book>> {
    return this.get(
      "bitget.spot.orderbook",
      `/api/v2/spot/market/orderbook?${qs({ symbol: spotSymbol(underlying), type: "step0", limit })}`,
      (b) => parseRestBook(b, "rtoken", underlying.toUpperCase()),
      (book) => book.ts,
    );
  }

  perpBook(underlying: string, limit: number | "max" = "max"): Promise<Sourced<Book>> {
    return this.get(
      "bitget.mix.orderbook",
      `/api/v2/mix/market/merge-depth?${qs({ symbol: perpSymbol(underlying), productType: "USDT-FUTURES", limit })}`,
      (b) => parseRestBook(b, "perp", underlying.toUpperCase()),
      (book) => book.ts,
    );
  }

  book(venue: Venue, underlying: string): Promise<Sourced<Book>> {
    return venue === "rtoken" ? this.spotBook(underlying) : this.perpBook(underlying);
  }

  fills(venue: Venue, underlying: string, limit = 100): Promise<Sourced<Trade[]>> {
    const path =
      venue === "rtoken"
        ? `/api/v2/spot/market/fills?${qs({ symbol: spotSymbol(underlying), limit })}`
        : `/api/v2/mix/market/fills?${qs({ symbol: perpSymbol(underlying), productType: "USDT-FUTURES", limit })}`;
    return this.get(`bitget.${venue === "rtoken" ? "spot" : "mix"}.fills`, path, parseFills, (_t, res) =>
      this.requestTime(res.body, res),
    );
  }

  spotTicker(underlying: string): Promise<Sourced<SpotTicker>> {
    return this.get(
      "bitget.spot.ticker",
      `/api/v3/market/tickers?${qs({ category: "SPOT", symbol: spotSymbol(underlying) })}`,
      parseSpotTicker,
      (t) => t.ts,
    );
  }

  perpTicker(underlying: string): Promise<Sourced<PerpTicker>> {
    return this.get(
      "bitget.mix.ticker",
      `/api/v3/market/tickers?${qs({ category: "USDT-FUTURES", symbol: perpSymbol(underlying) })}`,
      parsePerpTicker,
      (t) => t.ts,
    );
  }

  candles(venue: Venue, underlying: string, q: CandleQuery): Promise<Sourced<Candle[]>> {
    const symbol = venue === "rtoken" ? spotSymbol(underlying) : perpSymbol(underlying);
    const kind = q.history ? "history-candles" : "candles";
    let path: string;
    if (q.api === "v3") {
      const category = venue === "rtoken" ? "SPOT" : "USDT-FUTURES";
      path = `/api/v3/market/${kind}?${qs({ category, symbol, interval: V3_INTERVAL[q.interval], startTime: q.startTime, endTime: q.endTime, limit: q.limit })}`;
    } else if (venue === "rtoken") {
      path = `/api/v2/spot/market/${kind}?${qs({ symbol, granularity: V2_GRANULARITY.rtoken[q.interval], startTime: q.startTime, endTime: q.endTime, limit: q.limit })}`;
    } else {
      path = `/api/v2/mix/market/${kind}?${qs({ symbol, productType: "USDT-FUTURES", granularity: V2_GRANULARITY.perp[q.interval], startTime: q.startTime, endTime: q.endTime, limit: q.limit })}`;
    }
    return this.get(`bitget.${venue === "rtoken" ? "spot" : "mix"}.candles`, path, parseCandles, (c, res) =>
      c.length > 0 ? (c[c.length - 1] as Candle).ts : this.requestTime(res.body, res),
    );
  }

  spotSymbolInfo(underlying: string): Promise<Sourced<SpotSymbolInfo>> {
    return this.get(
      "bitget.spot.symbol",
      `/api/v2/spot/public/symbols?${qs({ symbol: spotSymbol(underlying) })}`,
      parseSpotSymbol,
      (_d, res) => this.requestTime(res.body, res),
    );
  }

  perpContract(underlying: string): Promise<Sourced<PerpContractInfo>> {
    return this.get(
      "bitget.mix.contract",
      `/api/v2/mix/market/contracts?${qs({ productType: "USDT-FUTURES", symbol: perpSymbol(underlying) })}`,
      parseContract,
      (_d, res) => this.requestTime(res.body, res),
    );
  }

  /** v3 current funding: rate, interval, next settlement and any announced cash dividend. */
  currentFunding(underlying: string): Promise<Sourced<CurrentFunding>> {
    return this.get(
      "bitget.mix.funding",
      `/api/v3/market/current-fund-rate?${qs({ symbol: perpSymbol(underlying) })}`,
      parseCurrentFunding,
      (_d, res) => this.requestTime(res.body, res),
    );
  }

  async funding(underlying: string): Promise<Sourced<FundingInfo>> {
    const cur = await this.currentFunding(underlying);
    const { rate, intervalHours, nextFundingTime } = cur.data;
    return { ...cur, data: { rate, intervalHours, nextFundingTime } };
  }

  fundingHistory(underlying: string, pageSize = 100): Promise<Sourced<FundingPoint[]>> {
    return this.get(
      "bitget.mix.funding-history",
      `/api/v2/mix/market/history-fund-rate?${qs({ symbol: perpSymbol(underlying), productType: "USDT-FUTURES", pageSize })}`,
      parseFundingHistory,
      (p, res) => (p.length > 0 ? (p[p.length - 1] as FundingPoint).ts : this.requestTime(res.body, res)),
    );
  }

  /** Perp index constituents (the same endpoint `bgc market --action indexComponents` calls). */
  indexComponents(underlying: string): Promise<Sourced<IndexComponent[]>> {
    return this.get(
      "bitget.mix.index",
      `/api/v3/market/index-components?${qs({ symbol: perpSymbol(underlying) })}`,
      parseIndexComponents,
      (_d, res) => this.requestTime(res.body, res),
    );
  }

  stockInfo(underlying: string): Promise<Sourced<SymbolSessions & { unknownPeriods: string[] }>> {
    return this.get(
      "bitget.reality.session",
      `/api/v3/reality/market/stock-info?${qs({ symbol: spotSymbol(underlying) })}`,
      (b) => parseStockInfo(b, underlying),
      (_d, res) => this.requestTime(res.body, res),
      "reality",
    );
  }

  marketStates(now = this.clock()): Promise<Sourced<MarketStates>> {
    return this.get(
      "bitget.reality.session-states",
      "/api/v3/reality/market/states",
      (b) => parseStates(b, now),
      (_d, res) => this.requestTime(res.body, res),
      "reality",
    );
  }

  holidayCalendar(): Promise<Sourced<RealityCalendar>> {
    return this.get(
      "bitget.reality.calendar",
      "/api/v3/reality/market/calendar",
      parseCalendar,
      (_d, res) => this.requestTime(res.body, res),
      "reality",
    );
  }
}
