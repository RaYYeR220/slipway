// Gathers everything the planner and gate need for one symbol into a MarketSnapshot with full provenance.
// Critical inputs (sessions, fees) fail closed; books may be missing (the gate refuses on SOURCE_MISSING);
// optional evidence (MCP calendars) is time-boxed and degrades to "unavailable" without blocking the snapshot.
import type {
  Atlas,
  Book,
  Fees,
  FundingInfo,
  MarketEvent,
  MarketSnapshot,
  SourceRef,
  SymbolSessions,
  Venue,
} from "@slipway/core";
import { BitgetDataMcp, KNOWN_ENTRIES } from "./bitget-mcp.js";
import { type CachePolicy, ref, SourceCache } from "./cache.js";
import { windowEnd, windowStart } from "./events.js";
import { mergeHolidays, STATIC_HOLIDAYS_AS_OF, STATIC_HOLIDAYS_SOURCE } from "./holidays.js";
import { BitgetRest, SourceError } from "./rest.js";
import { SignalMcp } from "./signal-mcp.js";
import type {
  CurrentFunding,
  IndexComponent,
  InstrumentRules,
  IntegrityFlag,
  MarketStates,
  Optional,
  PerpContractInfo,
  PerpTicker,
  RealityCalendar,
  Sourced,
  SpotSymbolInfo,
  SpotTicker,
  Trade,
} from "./types.js";

const H = 3_600_000;
const DAY = 24 * H;

export const REFERENCE_POLICIES: Record<"instrument" | "stockInfo" | "states" | "calendar", CachePolicy> = {
  instrument: { ttlMs: H, maxStaleMs: 7 * DAY, retryAfterMs: 30_000 },
  stockInfo: { ttlMs: H, maxStaleMs: 7 * DAY, retryAfterMs: 30_000 },
  states: { ttlMs: 5 * 60_000, maxStaleMs: DAY, retryAfterMs: 30_000 },
  calendar: { ttlMs: H, maxStaleMs: 7 * DAY, retryAfterMs: 30_000 },
};

export interface LoadSnapshotOptions {
  atlas?: Atlas;
  now?: number;
  rest?: BitgetRest;
  /** bitget-mcp-server wrapper; `null` disables it. */
  dataMcp?: BitgetDataMcp | null;
  /** bitget-signal MCP wrapper; `null` disables it. */
  signal?: SignalMcp | null;
  cache?: SourceCache;
  eventHorizonDays?: number;
  /** Max wait for each optional MCP source before reporting it unavailable (the call keeps filling the cache). */
  optionalBudgetMs?: number;
}

export interface LoadedSnapshot extends MarketSnapshot {
  integrity: IntegrityFlag[];
  rules: Record<Venue, InstrumentRules>;
  tickers: { rtoken: SpotTicker | null; perp: PerpTicker | null };
}

export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly sources: SourceRef[],
    readonly integrity: IntegrityFlag[],
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

let defaults: { rest: BitgetRest; cache: SourceCache; dataMcp: BitgetDataMcp; signal: SignalMcp } | null =
  null;

function shared() {
  if (!defaults) {
    const cache = new SourceCache(
      process.env.SLIPWAY_CACHE_DIR ? { dir: process.env.SLIPWAY_CACHE_DIR } : {},
    );
    defaults = {
      rest: new BitgetRest(),
      cache,
      dataMcp: new BitgetDataMcp({ cache }),
      signal: new SignalMcp({ cache }),
    };
  }
  return defaults;
}

async function live<T>(p: Promise<Sourced<T>>, id: string): Promise<Optional<T>> {
  try {
    return await p;
  } catch (err) {
    const source =
      err instanceof SourceError
        ? err.source
        : { ...ref(id, "unavailable", null, String(err)), since: Date.now() };
    return { data: null, source, latencyMs: 0 };
  }
}

function budget<T>(p: Promise<Optional<T>>, ms: number, id: string, now: number): Promise<Optional<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Optional<T>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          data: null,
          source: {
            ...ref(
              id,
              "unavailable",
              null,
              `no answer within ${ms} ms; request continues and will fill the cache`,
            ),
            since: now,
          },
          latencyMs: ms,
        }),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const bps = (a: number, b: number): number => (a / b - 1) * 10_000;
const usd = (x: number): string =>
  `$${x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x.toFixed(0)}`;

/** Data-quality observations computed from the gathered sources. */
export function integrityChecks(input: {
  now: number;
  spotTicker: SpotTicker | null;
  spotFills: Trade[] | null;
  components: IndexComponent[] | null;
  books: Partial<Record<Venue, Book>>;
  contract: PerpContractInfo | null;
  funding: CurrentFunding | null;
  unknownPeriods: string[];
}): IntegrityFlag[] {
  const flags: IntegrityFlag[] = [];
  const { spotTicker: t, spotFills, components, books, contract, funding, now } = input;
  if (t?.platformTurnover24h && t.platformTurnover24h > 0) {
    const ratio = t.turnover24h / t.platformTurnover24h;
    if (ratio > 100) {
      flags.push({
        code: "RTOKEN_VOLUME_MIRROR",
        source: "bitget.spot.ticker",
        severity: "info",
        detail: `rToken turnover24h ${usd(t.turnover24h)} mirrors the US consolidated tape; Bitget-native platformTurnover24h is ${usd(t.platformTurnover24h)} (${Math.round(ratio).toLocaleString("en-US")}x smaller) — size participation on the latter`,
      });
    }
    const last = spotFills?.reduce((m, f) => Math.max(m, f.ts), 0) ?? 0;
    if (spotFills && (last === 0 || now - last > 6 * H)) {
      flags.push({
        code: "RTOKEN_TAPE_SILENT",
        source: "bitget.spot.fills",
        severity: "warn",
        detail: `last public rToken print ${last ? `${((now - last) / H).toFixed(1)} h ago` : "not in the window"} while platformTurnover24h is ${usd(t.platformTurnover24h)}: routed fills do not appear on the public tape, so tape-derived rToken liquidity understates it`,
      });
    }
  }
  if (components && components.length > 1) {
    const px = components.map((c) => c.price);
    const mean = px.reduce((a, b) => a + b, 0) / px.length;
    const spread = ((Math.max(...px) - Math.min(...px)) / mean) * 10_000;
    const wsum = components.reduce((a, c) => a + c.weight, 0);
    if (spread > 25) {
      flags.push({
        code: "INDEX_DISPERSION",
        source: "bitget.mix.index",
        severity: "warn",
        detail: `index sources disagree by ${spread.toFixed(1)} bps (${components.map((c) => `${c.source} ${c.price}`).join(", ")})`,
      });
    }
    if (Math.abs(wsum - 1) > 0.01) {
      flags.push({
        code: "INDEX_WEIGHTS",
        source: "bitget.mix.index",
        severity: "info",
        detail: `component weights sum to ${wsum.toFixed(4)}`,
      });
    }
  }
  for (const [venue, b] of Object.entries(books) as [Venue, Book][]) {
    const bid = b.bids[0]?.px;
    const ask = b.asks[0]?.px;
    if (bid !== undefined && ask !== undefined && bid >= ask) {
      flags.push({
        code: "BOOK_CROSSED",
        source: venue === "rtoken" ? "bitget.spot.orderbook" : "bitget.mix.orderbook",
        severity: "warn",
        detail: `best bid ${bid} >= best ask ${ask}`,
      });
    }
  }
  const rt = books.rtoken;
  const pp = books.perp;
  if (rt?.bids[0] && rt.asks[0] && pp?.bids[0] && pp.asks[0]) {
    const rMid = (rt.bids[0].px + rt.asks[0].px) / 2;
    const pMid = (pp.bids[0].px + pp.asks[0].px) / 2;
    const basis = bps(rMid, pMid);
    if (Math.abs(basis) > 75) {
      flags.push({
        code: "CROSS_VENUE_BASIS",
        source: "bitget.spot.orderbook",
        severity: "warn",
        detail: `rToken mid ${rMid} vs perp mid ${pMid}: ${basis.toFixed(1)} bps`,
      });
    }
  }
  if (contract && funding && contract.fundIntervalHours !== funding.intervalHours) {
    flags.push({
      code: "FUNDING_INTERVAL_MISMATCH",
      source: "bitget.mix.funding",
      severity: "warn",
      detail: `contract says ${contract.fundIntervalHours} h, funding endpoint says ${funding.intervalHours} h`,
    });
  }
  if (input.unknownPeriods.length > 0) {
    flags.push({
      code: "UNKNOWN_TRADING_PERIOD",
      source: "bitget.reality.session",
      severity: "warn",
      detail: `unrecognised tradingPeriod values: ${input.unknownPeriods.join(", ")}`,
    });
  }
  return flags;
}

export function perpDividendEvent(f: CurrentFunding, symbol: string): MarketEvent | null {
  if (f.cashDividend === null || f.cashDividend === 0 || f.cashDividendTime === null) return null;
  return {
    kind: "ex_dividend",
    symbol,
    ts: f.cashDividendTime,
    windowSec: 3600,
    label: `${symbol} perp cash dividend ${f.cashDividend} settles via funding at ${new Date(f.cashDividendTime).toISOString()}`,
    source: "bitget.mix.funding",
  };
}

export async function loadMarketSnapshot(
  symbol: string,
  opts: LoadSnapshotOptions = {},
): Promise<LoadedSnapshot> {
  const u = symbol.toUpperCase();
  const now = opts.now ?? Date.now();
  const rest = opts.rest ?? shared().rest;
  const cache = opts.cache ?? shared().cache;
  const dataMcp = opts.dataMcp === undefined ? shared().dataMcp : opts.dataMcp;
  const signal = opts.signal === undefined ? shared().signal : opts.signal;
  const horizon = now + (opts.eventHorizonDays ?? 14) * DAY;
  const optionalMs = opts.optionalBudgetMs ?? 2_500;

  const reference = <T>(key: string, id: string, policy: CachePolicy, fn: () => Promise<Sourced<T>>) =>
    cache.fetch(key, id, policy, async () => {
      const r = await fn();
      return { value: r.data, asOf: r.source.asOf, ...(r.source.detail ? { detail: r.source.detail } : {}) };
    });

  const optional = <T>(p: Promise<Optional<T>> | null, id: string): Promise<Optional<T>> =>
    p
      ? budget(p, optionalMs, id, now)
      : Promise.resolve({
          data: null,
          source: ref(id, "unavailable", null, "source disabled"),
          latencyMs: 0,
        });

  const [
    spotBook,
    perpBook,
    spotSym,
    contract,
    funding,
    components,
    spotTicker,
    perpTicker,
    spotFills,
    stockInfo,
    states,
    calendar,
    earnings,
    actions,
    macro,
  ] = await Promise.all([
    live(rest.spotBook(u), "bitget.spot.orderbook"),
    live(rest.perpBook(u), "bitget.mix.orderbook"),
    reference<SpotSymbolInfo>(
      `rest:spot-symbol:${u}`,
      "bitget.spot.symbol",
      REFERENCE_POLICIES.instrument,
      () => rest.spotSymbolInfo(u),
    ),
    reference<PerpContractInfo>(
      `rest:contract:${u}`,
      "bitget.mix.contract",
      REFERENCE_POLICIES.instrument,
      () => rest.perpContract(u),
    ),
    live(rest.currentFunding(u), "bitget.mix.funding"),
    live(rest.indexComponents(u), "bitget.mix.index"),
    live(rest.spotTicker(u), "bitget.spot.ticker"),
    live(rest.perpTicker(u), "bitget.mix.ticker"),
    live(rest.fills("rtoken", u, 20), "bitget.spot.fills"),
    reference(`rest:stock-info:${u}`, "bitget.reality.session", REFERENCE_POLICIES.stockInfo, () =>
      rest.stockInfo(u),
    ),
    reference<MarketStates>("rest:states", "bitget.reality.session-states", REFERENCE_POLICIES.states, () =>
      rest.marketStates(now),
    ),
    reference<RealityCalendar>("rest:calendar", "bitget.reality.calendar", REFERENCE_POLICIES.calendar, () =>
      rest.holidayCalendar(),
    ),
    optional(
      dataMcp ? dataMcp.earnings(u, now - 2 * DAY, horizon) : null,
      `bitget-mcp.${KNOWN_ENTRIES.earnings.id}`,
    ),
    optional(
      dataMcp ? dataMcp.corporateActions(u, now - 2 * DAY, horizon) : null,
      `bitget-mcp.${KNOWN_ENTRIES.dividends.id}`,
    ),
    optional(signal ? signal.macroEvents(now, horizon) : null, "bitget-signal.macro_indicators"),
  ]);

  const holidays = mergeHolidays(calendar.data, now);
  const sources: SourceRef[] = [
    spotBook.source,
    perpBook.source,
    spotSym.source,
    contract.source,
    funding.source,
    components.source,
    spotTicker.source,
    perpTicker.source,
    spotFills.source,
    stockInfo.source,
    states.source,
    calendar.source,
    ...(holidays.staticUsed > 0
      ? [
          ref(
            STATIC_HOLIDAYS_SOURCE,
            "cached",
            STATIC_HOLIDAYS_AS_OF,
            `${holidays.staticUsed} closure(s) not yet published by Bitget`,
          ),
        ]
      : []),
    earnings.source,
    actions.source,
    macro.source,
  ];

  const books: Partial<Record<Venue, Book>> = {};
  if (spotBook.data) books.rtoken = spotBook.data;
  if (perpBook.data) books.perp = perpBook.data;

  const integrity: IntegrityFlag[] = [
    ...(states.data?.flags ?? []),
    ...(calendar.data?.flags ?? []),
    ...holidays.flags,
    ...integrityChecks({
      now,
      spotTicker: spotTicker.data,
      spotFills: spotFills.data,
      components: components.data,
      books,
      contract: contract.data,
      funding: funding.data,
      unknownPeriods: stockInfo.data?.unknownPeriods ?? [],
    }),
  ];

  const missing: string[] = [];
  if (!stockInfo.data) missing.push("Reality stock-info (sessions)");
  if (!spotSym.data) missing.push("rToken fees/rules");
  if (!contract.data) missing.push("perp fees/rules");
  if (missing.length > 0)
    throw new SnapshotError(
      `critical source(s) unavailable for ${u}: ${missing.join(", ")}`,
      sources,
      integrity,
    );
  const si = stockInfo.data as SymbolSessions & { unknownPeriods: string[] };
  const spot = spotSym.data as SpotSymbolInfo;
  const perp = contract.data as PerpContractInfo;

  const events: MarketEvent[] = [];
  const seen = new Set<string>();
  const dividend = funding.data ? perpDividendEvent(funding.data, u) : null;
  for (const e of [
    ...(earnings.data ?? []),
    ...(actions.data ?? []),
    ...(dividend ? [dividend] : []),
    ...(macro.data ?? []),
  ]) {
    const key = `${e.kind}|${e.symbol ?? ""}|${e.ts}`;
    if (seen.has(key) || windowEnd(e) < now || windowStart(e) > horizon) continue;
    seen.add(key);
    events.push(e);
  }
  events.sort((a, b) => a.ts - b.ts);

  const fundingInfo: FundingInfo | null = funding.data
    ? {
        rate: funding.data.rate,
        intervalHours: funding.data.intervalHours,
        nextFundingTime: funding.data.nextFundingTime,
      }
    : null;
  const fees: Record<Venue, Fees> = { rtoken: spot.fees, perp: perp.fees };
  const atlas: Atlas = {};
  for (const [k, v] of Object.entries(opts.atlas ?? {})) if (v.symbol === u) atlas[k] = v;

  return {
    symbol: u,
    now,
    books,
    fees,
    funding: fundingInfo,
    sessions: { symbol: si.symbol, tradingPeriods: si.tradingPeriods, weekendTradable: si.weekendTradable },
    holidays: holidays.closures,
    atlas,
    events,
    ...(components.data
      ? {
          indexComponents: components.data.map((c) => ({
            source: c.source,
            price: c.price,
            weight: c.weight,
          })),
        }
      : {}),
    sources,
    integrity,
    rules: { rtoken: spot.rules, perp: perp.rules },
    tickers: { rtoken: spotTicker.data, perp: perpTicker.data },
  };
}
