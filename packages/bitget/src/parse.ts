// Pure parsers from Bitget public payloads (REST envelopes and WS pushes) to typed values.
// They reject malformed data instead of guessing; numbers arrive as strings or numbers depending on the endpoint.
import {
  type Book,
  bookFromBitget,
  type Fees,
  type HolidayClosure,
  type RawLevel,
  type Session,
  type Side,
  type SymbolSessions,
  type Venue,
} from "@slipway/core";
import { isNyDaylightTime, parseNyLocal } from "./nytime.js";
import { exchangeSymbol, instTypeOf } from "./symbols.js";
import type {
  Candle,
  CurrentFunding,
  FundingPoint,
  IndexComponent,
  InstrumentRules,
  IntegrityFlag,
  MarketStates,
  PerpContractInfo,
  PerpTicker,
  RealityCalendar,
  SpotSymbolInfo,
  SpotTicker,
  Trade,
  WsTicker,
} from "./types.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new ParseError(`${field}: expected a number, got ${JSON.stringify(v)}`);
  return n;
}

export function optNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "null") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new ParseError(`${field}: expected a string, got ${JSON.stringify(v)}`);
  return v;
};

/** Unwraps the `{code, msg, requestTime, data}` envelope. */
export function envelope(body: unknown): { data: unknown; requestTime: number | null } {
  if (!isRec(body)) throw new ParseError("response is not an object");
  if (body.code !== "00000") throw new ParseError(`Bitget error ${String(body.code)}: ${String(body.msg)}`);
  return { data: body.data, requestTime: optNum(body.requestTime) };
}

const firstRow = (data: unknown, what: string): Rec => {
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRec(row)) throw new ParseError(`${what}: empty or malformed data`);
  return row;
};

const levelRows = (rows: unknown, field: string): RawLevel[] => {
  if (!Array.isArray(rows)) throw new ParseError(`${field}: expected an array of levels`);
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2)
      throw new ParseError(`${field}: malformed level ${JSON.stringify(row)}`);
  }
  return rows as RawLevel[];
};

/** `{asks, bids, ts}` (string or numeric levels) -> Book via core's bookFromBitget. */
function toBook(d: Rec, venue: Venue, underlying: string, what: string): Book {
  const ts = num(d.ts, `${what}.ts`);
  const asks = levelRows(d.asks, "asks");
  const bids = levelRows(d.bids, "bids");
  try {
    return bookFromBitget({
      instType: instTypeOf(venue),
      instId: exchangeSymbol(venue, underlying),
      ts,
      asks,
      bids,
    });
  } catch (err) {
    throw new ParseError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** GET /api/v2/spot/market/orderbook and /api/v2/mix/market/merge-depth (same `{asks,bids,ts}` shape). */
export function parseRestBook(body: unknown, venue: Venue, underlying: string): Book {
  return toBook(firstRow(envelope(body).data, "orderbook"), venue, underlying, "orderbook");
}

/** books1/books5/books15 push payload (`data[0]`). */
export function parseWsBookData(d: unknown, venue: Venue, underlying: string): Book & { seq: number | null } {
  if (!isRec(d)) throw new ParseError("ws book: malformed data");
  return { ...toBook(d, venue, underlying, "ws book"), seq: optNum(d.seq) };
}

const side = (v: unknown): Side => {
  if (v === "buy" || v === "sell") return v;
  throw new ParseError(`side: expected buy|sell, got ${JSON.stringify(v)}`);
};

export function parseTradeRow(r: unknown): Trade {
  if (!isRec(r)) throw new ParseError("trade: malformed row");
  return {
    id: str(r.tradeId ?? r.execId, "trade.id"),
    ts: num(r.ts, "trade.ts"),
    px: num(r.price, "trade.price"),
    sz: num(r.size, "trade.size"),
    side: side(r.side),
  };
}

/** GET /api/v2/spot/market/fills, /api/v2/mix/market/fills, /api/v3/market/fills. Newest first as published. */
export function parseFills(body: unknown): Trade[] {
  const { data } = envelope(body);
  if (!Array.isArray(data)) throw new ParseError("fills: expected an array");
  return data.map(parseTradeRow);
}

/** GET /api/v3/market/tickers?category=SPOT */
export function parseSpotTicker(body: unknown): SpotTicker {
  const t = firstRow(envelope(body).data, "spot ticker");
  return {
    symbol: str(t.symbol, "symbol"),
    ts: num(t.ts, "ts"),
    last: num(t.lastPrice, "lastPrice"),
    bid: num(t.bid1Price, "bid1Price"),
    ask: num(t.ask1Price, "ask1Price"),
    bidSz: num(t.bid1Size, "bid1Size"),
    askSz: num(t.ask1Size, "ask1Size"),
    volume24h: num(t.volume24h, "volume24h"),
    turnover24h: num(t.turnover24h, "turnover24h"),
    platformTurnover24h: optNum(t.platformTurnover24h),
  };
}

/** GET /api/v3/market/tickers?category=USDT-FUTURES */
export function parsePerpTicker(body: unknown): PerpTicker {
  const t = firstRow(envelope(body).data, "perp ticker");
  return {
    symbol: str(t.symbol, "symbol"),
    ts: num(t.ts, "ts"),
    last: num(t.lastPrice, "lastPrice"),
    bid: num(t.bid1Price, "bid1Price"),
    ask: num(t.ask1Price, "ask1Price"),
    bidSz: num(t.bid1Size, "bid1Size"),
    askSz: num(t.ask1Size, "ask1Size"),
    markPrice: num(t.markPrice, "markPrice"),
    indexPrice: num(t.indexPrice, "indexPrice"),
    fundingRate: num(t.fundingRate, "fundingRate"),
    openInterest: num(t.openInterest, "openInterest"),
    volume24h: num(t.volume24h, "volume24h"),
    turnover24h: num(t.turnover24h, "turnover24h"),
  };
}

/** WS `ticker` push row (spot or USDT-FUTURES). */
export function parseWsTickerRow(t: unknown): WsTicker {
  if (!isRec(t)) throw new ParseError("ws ticker: malformed row");
  return {
    symbol: str(t.instId ?? t.symbol, "instId"),
    ts: num(t.ts, "ts"),
    last: num(t.lastPr, "lastPr"),
    bid: num(t.bidPr, "bidPr"),
    ask: num(t.askPr, "askPr"),
    bidSz: num(t.bidSz, "bidSz"),
    askSz: num(t.askSz, "askSz"),
    markPrice: optNum(t.markPrice),
    indexPrice: optNum(t.indexPrice),
    fundingRate: optNum(t.fundingRate),
    nextFundingTime: optNum(t.nextFundingTime),
  };
}

/**
 * Candle rows from v2 spot `[ts,o,h,l,c,baseVol,usdtVol,quoteVol]`, v2 mix `[ts,o,h,l,c,baseVol,quoteVol]`
 * and v3 `[ts,o,h,l,c,volume,turnover]`. Returned oldest first.
 */
export function parseCandles(body: unknown): Candle[] {
  const { data } = envelope(body);
  if (!Array.isArray(data)) throw new ParseError("candles: expected an array");
  return data
    .map((row, i): Candle => {
      if (!Array.isArray(row) || row.length < 6) throw new ParseError(`candles[${i}]: malformed row`);
      return {
        ts: num(row[0], "candle.ts"),
        open: num(row[1], "candle.open"),
        high: num(row[2], "candle.high"),
        low: num(row[3], "candle.low"),
        close: num(row[4], "candle.close"),
        volume: num(row[5], "candle.volume"),
        quoteVolume: optNum(row[6]),
      };
    })
    .sort((a, b) => a.ts - b.ts);
}

const decimalsOf = (v: unknown, field: string): number => {
  const n = num(v, field);
  if (!Number.isInteger(n) || n < 0 || n > 18)
    throw new ParseError(`${field}: invalid precision ${JSON.stringify(v)}`);
  return n;
};

const fees = (r: Rec): Fees => ({
  maker: num(r.makerFeeRate, "makerFeeRate"),
  taker: num(r.takerFeeRate, "takerFeeRate"),
});

/** GET /api/v2/spot/public/symbols?symbol=R{SYM}USDT */
export function parseSpotSymbol(body: unknown): SpotSymbolInfo {
  const r = firstRow(envelope(body).data, "spot symbol");
  const pricePlace = decimalsOf(r.pricePrecision, "pricePrecision");
  const qtyPlace = decimalsOf(r.quantityPrecision, "quantityPrecision");
  const rules: InstrumentRules = {
    symbol: str(r.symbol, "symbol"),
    pricePlace,
    priceTick: 10 ** -pricePlace,
    qtyPlace,
    qtyStep: 10 ** -qtyPlace,
    minQty: num(r.minTradeAmount, "minTradeAmount"),
    minNotional: num(r.minTradeUSDT, "minTradeUSDT"),
    quotePlace: decimalsOf(r.quotePrecision, "quotePrecision"),
    buyLimitPriceRatio: optNum(r.buyLimitPriceRatio),
    sellLimitPriceRatio: optNum(r.sellLimitPriceRatio),
    maxMarketQty: null,
    maxMarketNotional: optNum(r.maxMarketOrderValue),
    maxLimitQty: null,
    maxLimitNotional: optNum(r.maxLimitOrderValue),
  };
  return {
    symbol: rules.symbol,
    baseCoin: str(r.baseCoin, "baseCoin"),
    status: str(r.status, "status"),
    fees: fees(r),
    rules,
    areaSymbol: r.areaSymbol === "yes",
  };
}

/** GET /api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol={SYM}USDT */
export function parseContract(body: unknown): PerpContractInfo {
  const r = firstRow(envelope(body).data, "contract");
  const pricePlace = decimalsOf(r.pricePlace, "pricePlace");
  const qtyPlace = decimalsOf(r.volumePlace, "volumePlace");
  const endStep = num(r.priceEndStep, "priceEndStep");
  const rules: InstrumentRules = {
    symbol: str(r.symbol, "symbol"),
    pricePlace,
    priceTick: endStep * 10 ** -pricePlace,
    qtyPlace,
    qtyStep: num(r.sizeMultiplier, "sizeMultiplier"),
    minQty: num(r.minTradeNum, "minTradeNum"),
    minNotional: num(r.minTradeUSDT, "minTradeUSDT"),
    quotePlace: pricePlace,
    buyLimitPriceRatio: optNum(r.buyLimitPriceRatio),
    sellLimitPriceRatio: optNum(r.sellLimitPriceRatio),
    maxMarketQty: optNum(r.maxMarketOrderQty),
    maxMarketNotional: null,
    maxLimitQty: optNum(r.maxOrderQty),
    maxLimitNotional: null,
  };
  return {
    symbol: rules.symbol,
    status: str(r.symbolStatus, "symbolStatus"),
    fees: fees(r),
    rules,
    fundIntervalHours: num(r.fundInterval, "fundInterval"),
    isRwa: r.isRwa === "YES",
    maxLeverage: num(r.maxLever, "maxLever"),
  };
}

/** GET /api/v2/mix/market/current-fund-rate or /api/v3/market/current-fund-rate (v3 adds cashDividend). */
export function parseCurrentFunding(body: unknown): CurrentFunding {
  const r = firstRow(envelope(body).data, "current funding");
  return {
    symbol: str(r.symbol, "symbol"),
    rate: num(r.fundingRate, "fundingRate"),
    intervalHours: num(r.fundingRateInterval, "fundingRateInterval"),
    nextFundingTime: num(r.nextUpdate, "nextUpdate"),
    minRate: optNum(r.minFundingRate),
    maxRate: optNum(r.maxFundingRate),
    cashDividend: optNum(r.cashDividend),
    cashDividendTime: optNum(r.cashDividendNextUpdate),
  };
}

/** GET /api/v2/mix/market/history-fund-rate (array) or /api/v3/market/history-fund-rate ({resultList}). Oldest first. */
export function parseFundingHistory(body: unknown): FundingPoint[] {
  const { data } = envelope(body);
  const rows = Array.isArray(data)
    ? data
    : isRec(data) && Array.isArray(data.resultList)
      ? data.resultList
      : null;
  if (!rows) throw new ParseError("funding history: expected rows");
  return rows
    .map((r: unknown): FundingPoint => {
      if (!isRec(r)) throw new ParseError("funding history: malformed row");
      return {
        ts: num(r.fundingTime ?? r.fundingRateTimestamp, "fundingTime"),
        rate: num(r.fundingRate, "fundingRate"),
      };
    })
    .sort((a, b) => a.ts - b.ts);
}

/** GET /api/v3/market/index-components?symbol={SYM}USDT */
export function parseIndexComponents(body: unknown): IndexComponent[] {
  const d = firstRow(envelope(body).data, "index components");
  if (!Array.isArray(d.componentList)) throw new ParseError("index components: missing componentList");
  return d.componentList.map((c: unknown): IndexComponent => {
    if (!isRec(c)) throw new ParseError("index component: malformed row");
    return {
      source: str(c.exchange, "exchange"),
      pair: str(c.spotPair, "spotPair"),
      price: num(c.equivalentPrice, "equivalentPrice"),
      weight: num(c.weight, "weight"),
    };
  });
}

const SESSIONS: readonly Session[] = [
  "pre_market",
  "regular",
  "after_hours",
  "overnight",
  "weekend",
  "closed",
];

/** GET /api/v3/reality/market/stock-info?symbol=R{SYM}USDT */
export function parseStockInfo(
  body: unknown,
  underlying: string,
): SymbolSessions & { unknownPeriods: string[] } {
  const rows = envelope(body).data;
  const want = `R${underlying.toUpperCase()}USDT`;
  const r = Array.isArray(rows) ? rows.find((x) => isRec(x) && x.symbol === want) : undefined;
  if (!isRec(r)) throw new ParseError(`stock-info: no row for ${want}`);
  if (!Array.isArray(r.tradingPeriod)) throw new ParseError("stock-info: missing tradingPeriod");
  const periods = r.tradingPeriod.map(String);
  return {
    symbol: underlying.toUpperCase(),
    tradingPeriods: periods.filter((p): p is Session => (SESSIONS as readonly string[]).includes(p)),
    weekendTradable: r.weekendTradable === "yes",
    unknownPeriods: periods.filter((p) => !(SESSIONS as readonly string[]).includes(p)),
  };
}

/**
 * GET /api/v3/reality/market/states. The published windows are New York wall clock; the `daylightType`/`timeZone`
 * labels are kept verbatim and compared with the real New York offset at `now`.
 */
export function parseStates(body: unknown, now: number): MarketStates {
  const d = firstRow(envelope(body).data, "market states");
  if (!Array.isArray(d.stateList)) throw new ParseError("market states: missing stateList");
  const windows = d.stateList.map((s: unknown) => {
    if (!isRec(s)) throw new ParseError("market states: malformed window");
    return {
      state: str(s.state, "state"),
      start: str(s.startTime, "startTime"),
      end: str(s.endTime, "endTime"),
      timeZoneLabel: str(s.timeZone, "timeZone"),
    };
  });
  const label = str(d.daylightType, "daylightType");
  const flags: IntegrityFlag[] = [];
  const dst = isNyDaylightTime(now);
  const labelSaysDst =
    label.toLowerCase() === "daylight" ||
    windows.some((w: { timeZoneLabel: string }) => w.timeZoneLabel === "EDT");
  if (dst !== labelSaysDst) {
    flags.push({
      code: "TZ_LABEL_MISMATCH",
      source: "bitget.reality.session-states",
      severity: "warn",
      detail: `Bitget reports daylightType "${label}" / timeZone "${windows[0]?.timeZoneLabel ?? "?"}" but New York is on ${dst ? "EDT (UTC-4)" : "EST (UTC-5)"}; session windows are applied as New York wall clock via the IANA zone, never via the label.`,
    });
  }
  return { market: str(d.market, "market"), daylightTypeLabel: label, windows, flags };
}

/** GET /api/v3/reality/market/calendar — closure windows are New York wall clock regardless of the "EST" label. */
export function parseCalendar(body: unknown): RealityCalendar {
  const d = firstRow(envelope(body).data, "calendar");
  const tz = str(d.timeZone, "timeZone");
  const specific = Array.isArray(d.specificConfig) ? d.specificConfig : [];
  const closures = specific.map((c: unknown) => {
    if (!isRec(c)) throw new ParseError("calendar: malformed closure");
    const startLocal = str(c.startTime, "startTime");
    const endLocal = str(c.endTime, "endTime");
    const start = parseNyLocal(startLocal);
    const end = parseNyLocal(endLocal);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new ParseError(`calendar: bad window ${startLocal} -> ${endLocal}`);
    }
    const remark = typeof c.remark === "string" && c.remark.trim() !== "" ? c.remark.trim() : undefined;
    return { start, end, startLocal, endLocal, ...(remark ? { label: remark } : {}) };
  });
  closures.sort((a: { start: number }, b: { start: number }) => a.start - b.start);
  const flags: IntegrityFlag[] = [];
  const dstClosures = closures.filter((c: { start: number }) => isNyDaylightTime(c.start));
  if (tz.toUpperCase() === "EST" && dstClosures.length > 0) {
    flags.push({
      code: "CALENDAR_TZ_LABEL",
      source: "bitget.reality.calendar",
      severity: "info",
      detail: `calendar labelled "${tz}" but ${dstClosures.length} of ${closures.length} closures fall in EDT; windows interpreted as New York wall clock.`,
    });
  }
  return {
    timeZoneLabel: tz,
    closures,
    weeklyClosedDays: Array.isArray(d.regularConfig) ? d.regularConfig.map(String) : [],
    flags,
  };
}

export const toHolidayClosures = (cal: RealityCalendar): HolidayClosure[] =>
  cal.closures.map((c) => ({
    start: c.start,
    end: c.end,
    label: c.label ?? `Reality closure ${c.startLocal} -> ${c.endLocal}`,
  }));
