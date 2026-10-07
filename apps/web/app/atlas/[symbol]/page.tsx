import type { Book, LiquidityStats } from "@slipway/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import styles from "@/components/atlas/atlas.module.css";
import { FLAG_INFO, flagTitle, parseFlags, symbolsOf, venueStats } from "@/components/atlas/atlasData";
import { DepthProfile, type Ladder } from "@/components/atlas/DepthProfile";
import { DOMAIN, METRICS, metricOf, metricT } from "@/components/atlas/geometry";
import { MetricLegend } from "@/components/atlas/Legend";
import { Spiral } from "@/components/atlas/Spiral";
import { WeekStrip } from "@/components/landing/WeekStrip";
import { TableView, Unavailable } from "@/components/site/Code";
import { ATLAS_URL, getAtlas } from "@/components/site/data";
import { Footer } from "@/components/site/Footer";
import { bp, num, nyTime, seconds, sessionLabel, usd } from "@/components/site/fmt";
import { Header } from "@/components/site/Header";
import { HOW, HOW_PUBLIC_PATH, howSourceLine } from "@/components/site/how";
import ui from "@/components/site/ui.module.css";

export const revalidate = 60;

const SESSION_ORDER = ["pre_market", "regular", "after_hours", "overnight", "weekend"];
const VENUES = ["rtoken", "perp"] as const;
const vColor = (v: string) => (v === "rtoken" ? "var(--venue-rtoken)" : "var(--venue-perp)");

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  const s = symbol.toUpperCase();
  return {
    title: `${s} liquidity`,
    description: `rToken R${s}USDT and the ${s} perp, session by session, from Slipway's recording of Bitget's public books.`,
  };
}

function ladder(book: Book | undefined, venue: "rtoken" | "perp", name: string): Ladder | null {
  const bb = book?.bids[0];
  const ba = book?.asks[0];
  if (!book || !bb || !ba) return null;
  const mid = (bb.px + ba.px) / 2;
  const side = (lv: { px: number; sz: number }[], sign: 1 | -1): [number, number][] => {
    let c = 0;
    const out: [number, number][] = [];
    for (const l of lv) {
      const d = sign * Math.abs(l.px / mid - 1) * 1e4;
      if (Math.abs(d) > 60) break;
      c += l.px * l.sz;
      out.push([Math.round(d * 100) / 100, Math.round(c)]);
    }
    return out;
  };
  return { venue, name, bids: side(book.bids, -1), asks: side(book.asks, 1) };
}

/** Distance from mid (bp) a market buy of `usd` walks on the ask side; null if the recorded book is too shallow. */
function walk(l: Ladder | null, notional: number): number | null {
  if (!l) return null;
  for (const [d, c] of l.asks) if (c >= notional) return d;
  return null;
}

const logPct = (v: number, m: "depth" | "spread" | "halflife") =>
  `${Math.max(2, metricT(v, m) * 100).toFixed(2)}%`;

export default async function SymbolAtlas({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ m?: string; s?: string }>;
}) {
  const [{ symbol: raw }, sp] = await Promise.all([params, searchParams]);
  const symbol = raw.toUpperCase();
  const metric = metricOf(sp.m);
  const atlas = await getAtlas();
  if (atlas.ok && !symbolsOf(atlas.data).includes(symbol)) notFound();
  const qm = metric === "depth" ? "" : `m=${metric}`;
  const how = HOW.series[symbol];

  if (!atlas.ok)
    return (
      <>
        <Header current="atlas" />
        <main id="main" className={ui.page}>
          <section className={styles.dTitle}>
            <h1 className={ui.h1}>{symbol}</h1>
            <Unavailable what="The liquidity atlas" url={atlas.url} error={atlas.error} />
          </section>
        </main>
        <Footer />
      </>
    );

  const st = {
    rtoken: venueStats(atlas.data, symbol, "rtoken"),
    perp: venueStats(atlas.data, symbol, "perp"),
  };
  const both = SESSION_ORDER.filter(
    (s) => st.rtoken[s]?.representativeBook || st.perp[s]?.representativeBook,
  );
  const session =
    sp.s && both.includes(sp.s)
      ? sp.s
      : (["regular", "overnight", "pre_market", "after_hours", "weekend"].find((s) => both.includes(s)) ??
        null);
  const ladders = session
    ? ([
        ladder(st.rtoken[session]?.representativeBook, "rtoken", `R${symbol}USDT`),
        ladder(st.perp[session]?.representativeBook, "perp", `${symbol}USDT perp`),
      ].filter(Boolean) as Ladder[])
    : [];
  const flags = parseFlags(atlas.data).filter((f) => f.symbol === symbol);
  const gaps = atlas.data.gapSigmaBps?.[symbol] ?? {};
  const basis = atlas.data.basisSigmaBpsPerSqrtHour?.[symbol];
  const cov = atlas.data.coverage ?? {};
  const link = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    if (metric !== "depth") q.set("m", metric);
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    const s = q.toString();
    return `/atlas/${symbol}${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <Header current="atlas" />
      <main id="main" className={ui.page}>
        <section className={styles.dTitle}>
          <nav aria-label="Symbols">
            <ul className={styles.crumbs}>
              <li>
                <Link href={`/atlas${qm ? `?${qm}` : ""}`}>All symbols</Link>
              </li>
              {symbolsOf(atlas.data).map((s) => (
                <li key={s}>
                  <Link
                    href={`/atlas/${s}${qm ? `?${qm}` : ""}`}
                    aria-current={s === symbol ? "page" : undefined}
                  >
                    {s}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <h1 className={ui.h1}>{symbol}</h1>
          <p className={styles.dSub}>
            The rToken R{symbol}USDT and the {symbol}USDT perp, compared session by session. Recorded{" "}
            {nyTime(atlas.data.window.from)} to {nyTime(atlas.data.window.to)}.
          </p>
        </section>

        <div className={styles.controls}>
          <nav className={ui.filters} aria-label="Metric">
            <span>Ink by</span>
            <span className={ui.seg}>
              {METRICS.map((m) => (
                <Link
                  key={m.id}
                  href={`/atlas/${symbol}${m.id === "depth" ? "" : `?m=${m.id}`}`}
                  aria-current={m.id === metric ? "true" : undefined}
                  scroll={false}
                >
                  {m.label}
                </Link>
              ))}
            </span>
          </nav>
          <MetricLegend metric={metric} />
        </div>

        <div className={styles.twin}>
          {VENUES.map((v) => (
            <figure key={v}>
              <div className={styles.twinSpiral}>
                <Spiral stats={st[v]} metric={metric} id={`d-${v}`} detailed label={`${symbol} ${v}`} />
              </div>
              <figcaption>
                {v === "rtoken" ? `R${symbol}USDT, rToken` : `${symbol}USDT, perp`}
                <span>
                  {SESSION_ORDER.filter((s) => st[v][s]).length} of 5 sessions recorded ·{" "}
                  {num(SESSION_ORDER.reduce((n, s) => n + (cov[`${symbol}|${v}|${s}`]?.snapshots ?? 0), 0))}{" "}
                  snapshots
                </span>
              </figcaption>
            </figure>
          ))}
        </div>

        <section className={ui.section} aria-labelledby="cmp-h">
          <div className={styles.head}>
            <h2 className={ui.h2} id="cmp-h">
              Session by session
            </h2>
            <p>
              Both venues side by side. Bars run on the same log scales as the coils, so a longer bar is
              deeper, wider or slower. Blank means the recorder has not seen that session yet.
            </p>
          </div>
          <div className={styles.cmp}>
            <div className={`${styles.cmpRow} ${styles.cmpHead}`} aria-hidden="true">
              <span>Session</span>
              <span>Spread, p10 · p50 · p90</span>
              <span>Depth ±25 bp, median</span>
              <span>Refill half-life</span>
              <span>Recorded</span>
            </div>
            {SESSION_ORDER.map((s) => (
              <div key={s} className={styles.cmpRow}>
                <span className={styles.cmpSession}>
                  {sessionLabel(s)}
                  <span>
                    {s === "weekend"
                      ? "Fri 20:00 → Sun 20:00 ET"
                      : s === "regular"
                        ? "09:30 → 16:00 ET"
                        : s === "pre_market"
                          ? "04:00 → 09:30 ET"
                          : s === "after_hours"
                            ? "16:00 → 20:00 ET"
                            : "20:00 → 04:00 ET"}
                  </span>
                </span>
                <span className={styles.cmpCell}>
                  <span className={styles.cmpLabel}>Spread, p10 · p50 · p90</span>
                  {VENUES.map((v) => {
                    const x: LiquidityStats | undefined = st[v][s];
                    return x ? (
                      <span key={v} className={styles.pairBar}>
                        <span>{v === "rtoken" ? "rToken" : "Perp"}</span>
                        <b>{bp(x.spreadBps.p50, 2)}</b>
                        <span className={styles.rangeTrack} aria-hidden="true">
                          <span
                            style={{
                              left: logPct(Math.max(x.spreadBps.p10, DOMAIN.spread[0]), "spread"),
                              width: `calc(${logPct(x.spreadBps.p90, "spread")} - ${logPct(Math.max(x.spreadBps.p10, DOMAIN.spread[0]), "spread")})`,
                              background: vColor(v),
                            }}
                          />
                          <em style={{ left: logPct(x.spreadBps.p50, "spread"), background: vColor(v) }} />
                        </span>
                      </span>
                    ) : (
                      <span key={v} className={styles.none}>
                        {v === "rtoken" ? "rToken" : "Perp"}: not recorded
                      </span>
                    );
                  })}
                </span>
                <span className={styles.cmpCell}>
                  <span className={styles.cmpLabel}>Depth ±25 bp</span>
                  {VENUES.map((v) => {
                    const x = st[v][s];
                    return x ? (
                      <span key={v} className={styles.pairBar}>
                        <span>{v === "rtoken" ? "rToken" : "Perp"}</span>
                        <b>{usd(x.depthUsd.b25.p50)}</b>
                        <i style={{ width: logPct(x.depthUsd.b25.p50, "depth"), background: vColor(v) }} />
                      </span>
                    ) : (
                      <span key={v} className={styles.none}>
                        —
                      </span>
                    );
                  })}
                </span>
                <span className={styles.cmpCell}>
                  <span className={styles.cmpLabel}>Refill half-life</span>
                  {VENUES.map((v) => {
                    const x = st[v][s];
                    if (!x)
                      return (
                        <span key={v} className={styles.none}>
                          —
                        </span>
                      );
                    return x.resilience ? (
                      <span key={v} className={styles.pairBar}>
                        <span>{v === "rtoken" ? "rToken" : "Perp"}</span>
                        <b>{seconds(x.resilience.halfLifeSec)}</b>
                        <i
                          style={{
                            width: logPct(x.resilience.halfLifeSec, "halflife"),
                            background: vColor(v),
                          }}
                        />
                      </span>
                    ) : (
                      <span key={v} className={styles.none}>
                        {v === "rtoken" ? "rToken" : "Perp"}: too few depletions to measure
                      </span>
                    );
                  })}
                </span>
                <span className={styles.cmpCell}>
                  <span className={styles.cmpLabel}>Recorded</span>
                  {VENUES.map((v) => {
                    const c = cov[`${symbol}|${v}|${s}`];
                    return c ? (
                      <span key={v} className={styles.pairBar}>
                        <span>{v === "rtoken" ? "rToken" : "Perp"}</span>
                        <span>
                          {num(c.snapshots)} books · {num(c.trades)} prints · {num(c.hours)} h
                        </span>
                      </span>
                    ) : (
                      <span key={v} className={styles.none}>
                        —
                      </span>
                    );
                  })}
                </span>
              </div>
            ))}
          </div>
          <TableView
            caption={`${symbol} atlas entries`}
            head={[
              "Venue",
              "Session",
              "Spread p10",
              "p50",
              "p90",
              "Depth ±10 bp",
              "±25 bp",
              "±50 bp",
              "Half-life",
              "σ bp/√s",
              "Flow $/min",
              "n",
            ]}
            numeric={[2, 3, 4, 5, 6, 7, 8, 9, 10, 11]}
            rows={VENUES.flatMap((v) =>
              SESSION_ORDER.flatMap((s) => {
                const x = st[v][s];
                return x
                  ? [
                      [
                        v === "rtoken" ? "rToken" : "Perp",
                        sessionLabel(s),
                        bp(x.spreadBps.p10, 2),
                        bp(x.spreadBps.p50, 2),
                        bp(x.spreadBps.p90, 2),
                        usd(x.depthUsd.b10.p50),
                        usd(x.depthUsd.b25.p50),
                        usd(x.depthUsd.b50.p50),
                        x.resilience ? seconds(x.resilience.halfLifeSec) : "n/a",
                        Number.isFinite(x.sigmaBpsPerSqrtSec) ? x.sigmaBpsPerSqrtSec.toFixed(3) : "n/a",
                        usd(x.tradeNotionalPerMin.p50),
                        num(x.n),
                      ],
                    ]
                  : [];
              }),
            )}
          />
        </section>

        <section className={ui.section} aria-labelledby="book-h">
          <div className={styles.head}>
            <h2 className={ui.h2} id="book-h">
              The book, as recorded
            </h2>
            <p>
              The representative book of a session: the real recorded snapshot with that session’s median
              depth. Read it outward from mid: how much notional each venue offers before a market order has
              moved the price that many basis points.
            </p>
          </div>
          <nav className={ui.filters} aria-label="Session">
            <span>Session</span>
            <span className={ui.seg}>
              {both.map((s) => (
                <Link
                  key={s}
                  href={link({ s })}
                  aria-current={s === session ? "true" : undefined}
                  scroll={false}
                >
                  {sessionLabel(s)}
                </Link>
              ))}
            </span>
          </nav>
          {ladders.length ? (
            <figure className={ui.plate}>
              <div className={ui.plateHead}>
                <figcaption className={ui.plateTitle}>
                  Cumulative depth from mid, {sessionLabel(session ?? "").toLowerCase()}
                </figcaption>
                <ul className={ui.legend} aria-label="Legend">
                  {ladders.map((l) => (
                    <li key={l.venue}>
                      <i className={ui.lineKey} style={{ background: vColor(l.venue) }} />
                      {l.name}
                    </li>
                  ))}
                </ul>
              </div>
              <DepthProfile ladders={ladders} />
              <p className={ui.caption}>
                <em>
                  {ladders
                    .map((l) => {
                      const w = walk(l, 100_000);
                      return `A $100k market buy on this ${l.venue === "rtoken" ? "rToken" : "perp"} book reaches ${
                        w === null ? "past the recorded levels" : `+${w.toFixed(1)} bp`
                      }`;
                    })
                    .join("; ")}
                  .
                </em>{" "}
                Before fees, and before the book refills.
                <span className={ui.source}>
                  {ladders
                    .map((l) => {
                      const b = st[l.venue][session ?? ""]?.representativeBook;
                      return `${l.name} book at ${nyTime(b?.ts)}`;
                    })
                    .join(" · ")}{" "}
                  · {ATLAS_URL}
                </span>
              </p>
            </figure>
          ) : (
            <p className={ui.body}>No representative book has been recorded for {symbol} yet.</p>
          )}
        </section>

        {how && (how.rtoken || how.perp) && (
          <section className={ui.section} aria-labelledby="flow-h">
            <div className={styles.head}>
              <h2 className={ui.h2} id="flow-h">
                Traded value through the week
              </h2>
              <p>
                From about five weeks of hourly candles rather than our own recording, so it reaches the
                regular session and the weekend even where the atlas has not yet. The rToken’s candles mirror
                routed US volume; the perp’s are Bitget’s own.
              </p>
            </div>
            <figure className={ui.plate}>
              <div className={ui.plateHead}>
                <figcaption className={ui.plateTitle}>Median USDT traded per hour, New York week</figcaption>
                <ul className={ui.legend} aria-label="Legend">
                  {how.rtoken && (
                    <li>
                      <i className={ui.key} style={{ background: "var(--venue-rtoken)" }} />R{symbol}USDT
                    </li>
                  )}
                  {how.perp && (
                    <li>
                      <i className={ui.lineKey} style={{ background: "var(--venue-perp)" }} />
                      {symbol}USDT perp
                    </li>
                  )}
                </ul>
              </div>
              {how.rtoken ? (
                <WeekStrip
                  rtoken={how.rtoken.vol}
                  perp={how.perp?.vol ?? null}
                  weeks={how.rtoken.weeks}
                  rtokenName={`R${symbol}USDT`}
                  perpName={`${symbol}USDT perp`}
                />
              ) : (
                <p className={ui.body}>No rToken candles for {symbol}.</p>
              )}
              <p className={ui.caption}>
                <span className={ui.source}>
                  {how.rtoken ? howSourceLine(how.rtoken) : ""} ·{" "}
                  <a href={HOW_PUBLIC_PATH}>{HOW_PUBLIC_PATH}</a>
                </span>
              </p>
            </figure>
          </section>
        )}

        <section className={ui.section} aria-labelledby="wait-h">
          <div className={styles.head}>
            <h2 className={ui.h2} id="wait-h">
              The price of waiting
            </h2>
            <p>
              Waiting for a deeper session is not free: the price can move before you trade. The planner
              charges each wait the historical standard deviation of the move between sessions, and each
              rotation the volatility of the perp–rToken basis.
            </p>
          </div>
          <ul className={styles.gaps}>
            {SESSION_ORDER.filter((s) => s !== "regular").map((s) => (
              <li key={s}>
                <span>{sessionLabel(s)} → regular session</span>
                <strong>
                  {VENUES.map((v) => {
                    const g = gaps[`${v}|${s}->regular`];
                    return `${v === "rtoken" ? "rToken" : "perp"} ${typeof g === "number" ? `${g.toFixed(0)} bp` : "n/a"}`;
                  }).join(" · ")}
                </strong>
                <span>σ of the move, 60 days of 1h candles</span>
              </li>
            ))}
            <li>
              <span>Perp against rToken</span>
              <strong>
                {typeof basis === "number" ? `${basis.toFixed(1)} bp per √hour` : "not measured"}
              </strong>
              <span>basis volatility, for perp-then-rotate</span>
            </li>
          </ul>
        </section>

        {flags.length > 0 && (
          <section className={ui.section} aria-labelledby="sflags-h">
            <div className={styles.head}>
              <h2 className={ui.h2} id="sflags-h">
                Flags for {symbol}
              </h2>
              <p>As published with the atlas. They limit what the desk will claim for this symbol.</p>
            </div>
            <ul className={styles.flags}>
              {[...new Set(flags.map((f) => f.type))].map((type) => {
                const list = flags.filter((f) => f.type === type);
                return (
                  <li key={type} className={styles.flag}>
                    <span className={styles.flagHead}>
                      <strong>{flagTitle(type)}</strong>
                      <span className={styles.flagCount}>
                        {num(list.length)} key{list.length > 1 ? "s" : ""}
                      </span>
                    </span>
                    {FLAG_INFO[type] && <span>{FLAG_INFO[type]?.text}</span>}
                    <ul className={styles.flagList}>
                      {list.map((f) => (
                        <li key={`${f.key}|${f.text}`}>
                          <code>{f.key}</code> {f.text}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}
