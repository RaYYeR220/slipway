import { buildAtlas, buildLiquidityStats } from "../src/atlas.js";
import { bookFromBitget, bookSeries } from "../src/book.js";
import { framesFromTape } from "../src/resilience.js";
import { nyseHolidayClosures } from "../src/session.js";
import type { Atlas, Book, Fees, FundingInfo, MarketSnapshot, SymbolSessions, Venue } from "../src/types.js";
import { fixture, instrument, type SequenceFixture } from "./helpers.js";

interface Reference {
  derived: { basisSigmaBpsPerSqrtHour: Record<string, number> };
  spotSymbols: Record<string, { makerFeeRate: string; takerFeeRate: string }>;
  perpContracts: Record<string, { makerFeeRate: string; takerFeeRate: string; fundInterval: string }>;
  stockInfo: Record<string, { code: string; tradingPeriod: string[]; weekendTradable: string }>;
}

const ref = fixture<Reference>("reference.json");
const spot = ref.spotSymbols.RNVDAUSDT as Reference["spotSymbols"][string];
const contract = ref.perpContracts.NVDAUSDT as Reference["perpContracts"][string];
const info = ref.stockInfo.RNVDAUSDT as Reference["stockInfo"][string];

export const FEES: Record<Venue, Fees> = {
  rtoken: { maker: Number(spot.makerFeeRate), taker: Number(spot.takerFeeRate) },
  perp: { maker: Number(contract.makerFeeRate), taker: Number(contract.takerFeeRate) },
};

export const NVDA_BASIS_SIGMA = ref.derived.basisSigmaBpsPerSqrtHour.NVDA as number;

export const NVDA_SESSIONS: SymbolSessions = {
  symbol: "NVDA",
  tradingPeriods: info.tradingPeriod as SymbolSessions["tradingPeriods"],
  weekendTradable: info.weekendTradable === "yes",
};

const seqStats = (file: string, venue: Venue) => {
  const s = fixture<SequenceFixture>(file);
  return buildLiquidityStats({
    symbol: "NVDA",
    venue,
    session: "overnight",
    frames: framesFromTape(bookSeries(s.books, venue, "NVDA"), s.trades),
    depthBooks: bookSeries(s.depth ?? [], venue, "NVDA"),
  });
};

const momentStats = (instId: string, venue: Venue) => {
  const x = instrument("nvda-books.json", "after_hours", instId);
  const top = bookFromBitget(x.books15);
  return buildLiquidityStats({
    symbol: "NVDA",
    venue,
    session: "after_hours",
    frames: [{ ts: top.ts, book: top, trades: [] }],
    depthBooks: [bookFromBitget(x.depth)],
  });
};

let atlasCache: Atlas | undefined;
export function nvdaAtlas(): Atlas {
  atlasCache ??= buildAtlas([
    seqStats("nvda-perp-sequence.json", "perp"),
    seqStats("rnvda-sequence.json", "rtoken"),
    momentStats("NVDAUSDT", "perp"),
    momentStats("RNVDAUSDT", "rtoken"),
  ]);
  return atlasCache;
}

export const liveBook = (moment: "overnight" | "after_hours", venue: Venue): Book =>
  bookFromBitget(instrument("nvda-books.json", moment, venue === "perp" ? "NVDAUSDT" : "RNVDAUSDT").depth);

export const retime = (book: Book, ts: number): Book => ({ ...book, ts });

export function funding(moment: "overnight" | "after_hours"): FundingInfo {
  const t = instrument("nvda-books.json", moment, "NVDAUSDT").ticker;
  if (!t) throw new Error("no ticker");
  return {
    rate: Number(t.funding),
    intervalHours: Number(contract.fundInterval),
    nextFundingTime: Number(t.nextFunding),
  };
}

// Live NVDA market as recorded at the overnight (Mon 22:30 NY) or after-hours (Mon 19:30 NY) moment.
export function nvdaSnapshot(
  moment: "overnight" | "after_hours" = "overnight",
  patch: Partial<MarketSnapshot> = {},
): MarketSnapshot {
  const rtoken = liveBook(moment, "rtoken");
  const perp = liveBook(moment, "perp");
  const now = Math.max(rtoken.ts, perp.ts) + 500;
  return {
    symbol: "NVDA",
    now,
    books: { rtoken, perp },
    fees: FEES,
    funding: funding(moment),
    sessions: NVDA_SESSIONS,
    holidays: nyseHolidayClosures(),
    atlas: nvdaAtlas(),
    events: [],
    basisSigmaBpsPerSqrtHour: NVDA_BASIS_SIGMA,
    sources: [
      { id: "bitget.spot.orderbook", status: "live", asOf: rtoken.ts },
      { id: "bitget.mix.orderbook", status: "live", asOf: perp.ts },
      { id: "bitget.reality.session", status: "live", asOf: now },
    ],
    ...patch,
  };
}
