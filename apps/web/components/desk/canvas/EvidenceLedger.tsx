"use client";
// The evidence ledger: a station list of every data source the desk read this session, grouped by provider, with
// its last observation and its age. Sources that failed say so, and since when.
import { age, num, nyClock, price, signed } from "@/lib/desk/format";
import type { DeskState, Held, MarketData, ResearchData, SourceRef } from "@/lib/desk/types";
import { useNow } from "../../charts/hooks";
import c from "./canvas.module.css";
import { SectionHead } from "./parts";

const GROUPS: { id: string; title: string; note: string; test: (id: string) => boolean }[] = [
  {
    id: "spot",
    title: "Bitget spot",
    note: "rToken books, fees, fills, tickers",
    test: (i) => i.startsWith("bitget.spot."),
  },
  {
    id: "perp",
    title: "Bitget perps",
    note: "USDT-M books, contract, funding, index",
    test: (i) => i.startsWith("bitget.mix."),
  },
  {
    id: "reality",
    title: "Bitget Reality",
    note: "trading sessions and the market calendar",
    test: (i) => i.startsWith("bitget.reality."),
  },
  {
    id: "mcp",
    title: "bitget-mcp skill",
    note: "earnings, dividends, cash quote, news, sentiment",
    test: (i) => i.startsWith("bitget-mcp."),
  },
  {
    id: "signal",
    title: "bitget-signal skill",
    note: "derivatives, technicals, macro, news",
    test: (i) => i.startsWith("bitget-signal."),
  },
  {
    id: "tape",
    title: "Slipway tape",
    note: "the recorded liquidity atlas and track record",
    test: (i) => i.startsWith("slipway."),
  },
  { id: "ref", title: "Reference", note: "static fallbacks, flagged", test: () => true },
];

interface Props {
  sources: DeskState["sources"];
  market: Held<MarketData> | null;
  research: Held<ResearchData> | null;
}

function Row({ s, now }: { s: SourceRef; now: number }) {
  const down = s.status === "unavailable";
  const when = down
    ? s.since
      ? `down ${age(now - s.since)}`
      : "down"
    : s.asOf
      ? `${age(now - s.asOf)} ago`
      : "no timestamp";
  const detail = down
    ? [s.since ? `Unavailable since ${nyClock(s.since)} NY.` : "Unavailable.", s.detail]
        .filter(Boolean)
        .join(" ")
    : s.detail;
  return (
    <li className={c.station} data-status={s.status}>
      <span className={c.stationMark} data-status={s.status} aria-hidden="true" />
      <span className={c.stationId}>{s.id}</span>
      <span className={c.stationAge}>{when}</span>
      <span className={c.stationStatus}>{s.status}</span>
      {detail ? <span className={c.stationDetail}>{detail}</span> : null}
    </li>
  );
}

export function EvidenceLedger({ sources, market, research }: Props) {
  const now = useNow(1000);
  const all = Object.values(sources).map((x) => x.ref);
  const counts = { live: 0, cached: 0, unavailable: 0 };
  for (const s of all) counts[s.status]++;
  const used = new Set<string>();
  const groups = GROUPS.map((g) => {
    const items = all.filter((s) => !used.has(s.id) && g.test(s.id)).sort((a, b) => a.id.localeCompare(b.id));
    for (const s of items) used.add(s.id);
    return { ...g, items };
  });
  const flags = [
    ...(market?.data.integrity ?? []).map((f) => ({ ...f, from: "market" })),
    ...(research?.data.flags ?? []).map((f) => ({ ...f, from: "research" })),
  ];
  const r = research?.data ?? null;

  return (
    <section className={c.section} aria-labelledby="h-ledger" id="desk-ledger">
      <SectionHead
        id="h-ledger"
        title="Evidence ledger"
        lede="Every source behind the numbers on this page, with its last observation. Live means read from Bitget for this request; cached means a recent copy within its freshness budget."
        aside={
          all.length ? (
            <span className={c.status}>
              {all.length} sources: {counts.live} live, {counts.cached} cached, {counts.unavailable}{" "}
              unavailable
            </span>
          ) : null
        }
      />
      {all.length === 0 ? (
        <p className={c.note}>Sources appear here as the desk reads them.</p>
      ) : (
        <div className={c.stations}>
          {groups
            .filter((g) => g.items.length)
            .map((g) => (
              <div key={g.id} className={c.stationGroup}>
                <h3 className={c.stationTitle}>
                  {g.title}
                  <span className={c.stationNote}>{g.note}</span>
                </h3>
                <ul className={c.stationList}>
                  {g.items.map((s) => (
                    <Row key={s.id} s={s} now={now} />
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}

      {flags.length ? (
        <div className={c.crossChecks}>
          <h3 className={c.h3}>Cross-checks</h3>
          <p className={c.note}>
            Where sources disagree with each other or with themselves, the desk says so instead of picking one
            quietly.
          </p>
          <ul className={c.flagList}>
            {flags.map((f) => (
              <li key={`${f.code}-${f.source}`} className={c.flagItem} data-severity={f.severity}>
                <span className={c.flagCode}>{f.code}</span>
                <span className={c.flagSource}>{f.source}</span>
                <span className={c.flagDetail}>{f.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {r && (r.perp24h || r.technicals || r.quote) ? (
        <div className={c.context}>
          <h3 className={c.h3}>Context for {r.symbol}</h3>
          <p className={c.note}>
            Read through Bitget's skills for the conversation; not an input to the cost model.
          </p>
          <dl className={c.contextGrid}>
            {r.quote?.last != null ? (
              <div>
                <dt>Cash quote</dt>
                <dd>
                  {price(r.quote.last)}
                  {r.quote.changePct != null ? ` (${signed(r.quote.changePct, 2)}%)` : ""}
                </dd>
              </div>
            ) : null}
            {r.perp24h ? (
              <div>
                <dt>Perp, 24 h</dt>
                <dd>
                  {price(r.perp24h.last)} ({signed(r.perp24h.changePct, 2)}%), range {price(r.perp24h.low)} to{" "}
                  {price(r.perp24h.high)}
                </dd>
              </div>
            ) : null}
            {r.technicals ? (
              <>
                <div>
                  <dt>RSI 14, hourly</dt>
                  <dd>{num(r.technicals.rsi14, 1)}</dd>
                </div>
                <div>
                  <dt>Hourly volatility</dt>
                  <dd>{num(r.technicals.hourlyVolBps, 1)} bp</dd>
                </div>
              </>
            ) : null}
            {r.bollinger ? (
              <div>
                <dt>Bollinger 20, recomputed</dt>
                <dd>
                  {price(r.bollinger.recomputed.lower)} to {price(r.bollinger.recomputed.upper)}
                </dd>
              </div>
            ) : null}
            {r.fearGreed ? (
              <div>
                <dt>Fear and greed</dt>
                <dd>
                  {r.fearGreed.score}
                  {r.fearGreed.rating ? `, ${r.fearGreed.rating}` : ""}
                </dd>
              </div>
            ) : null}
          </dl>
          {r.headlines.length ? (
            <ul className={c.headlines}>
              {r.headlines.slice(0, 4).map((h) => (
                <li key={`${h.source}-${h.title}`}>
                  {h.title} <span className={c.dim}>({h.source})</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
