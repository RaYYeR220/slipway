import type { Metadata } from "next";
import Link from "next/link";
import styles from "@/components/atlas/atlas.module.css";
import { FLAG_INFO, flagTitle, parseFlags, symbolsOf, venueStats } from "@/components/atlas/atlasData";
import { METRICS, metricOf, metricValue, WEEK_SPANS } from "@/components/atlas/geometry";
import { MetricLegend } from "@/components/atlas/Legend";
import { realityCheck } from "@/components/atlas/live";
import { formatMetric, Spiral } from "@/components/atlas/Spiral";
import { Unavailable } from "@/components/site/Code";
import { ATLAS_URL, getAtlas } from "@/components/site/data";
import { Footer } from "@/components/site/Footer";
import { ago, num, nyTime, sessionLabel } from "@/components/site/fmt";
import { Header } from "@/components/site/Header";
import ui from "@/components/site/ui.module.css";

export const revalidate = 60;
export const metadata: Metadata = {
  title: "Liquidity atlas",
  description:
    "Spread, depth within 25 bp and book refill for every Bitget tokenized stock, per venue and New York session, from Slipway's own recording of the public order books.",
};

const SESSION_ORDER = ["pre_market", "regular", "after_hours", "overnight", "weekend"];

export default async function AtlasPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const sp = await searchParams;
  const metric = metricOf(sp.m);
  const [atlas, live] = await Promise.all([getAtlas(), realityCheck()]);
  const q = metric === "depth" ? "" : `?m=${metric}`;

  return (
    <>
      <Header current="atlas" />
      <main id="main" className={ui.page}>
        <section className={styles.title}>
          <h1 className={ui.h1}>Liquidity atlas</h1>
          <p className={ui.lede}>
            How deep and how tight each Bitget tokenized stock is, on the rToken and on the perp, in each New
            York session: measured from Slipway’s own recording of Bitget’s public order books. The planner
            prices every future slice against these numbers. Sessions not recorded yet are hatched, not
            guessed.
          </p>
          {atlas.ok && (
            <dl className={styles.facts}>
              <div>
                <dt>Recorded</dt>
                <dd>
                  {nyTime(atlas.data.window.from)} → {nyTime(atlas.data.window.to)}
                </dd>
              </div>
              <div>
                <dt>Keys</dt>
                <dd>{num(Object.keys(atlas.data.atlas).length)} symbol × venue × session</dd>
              </div>
              <div>
                <dt>Book snapshots</dt>
                <dd>{num(Object.values(atlas.data.coverage ?? {}).reduce((s, c) => s + c.snapshots, 0))}</dd>
              </div>
              <div>
                <dt>Rebuilt</dt>
                <dd>{ago(atlas.data.generatedAt, Date.now())}</dd>
              </div>
            </dl>
          )}
        </section>

        {!atlas.ok ? (
          <Unavailable what="The liquidity atlas" url={atlas.url} error={atlas.error} />
        ) : (
          <>
            <div className={styles.controls}>
              <nav className={ui.filters} aria-label="Metric">
                <span>Ink by</span>
                <span className={ui.seg}>
                  {METRICS.map((m) => (
                    <Link
                      key={m.id}
                      href={m.id === "depth" ? "/atlas" : `/atlas?m=${m.id}`}
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
            <p className={styles.howTo}>
              Each coil is one week, one turn per day from Sunday at the centre; midnight New York is at the
              top and the hours run clockwise. Under each coil: its best recorded session (deepest, tightest
              or fastest to refill). Open a symbol to compare its two venues session by session.
            </p>

            <ul className={styles.grid}>
              {symbolsOf(atlas.data).map((sym) => {
                const r = venueStats(atlas.data, sym, "rtoken");
                const p = venueStats(atlas.data, sym, "perp");
                const sessions = (st: typeof r) =>
                  SESSION_ORDER.filter((s) => metricValue(st[s], metric) !== null);
                const flags = parseFlags(atlas.data).filter((f) => f.symbol === sym && f.type !== "METHOD");
                const best = (st: typeof r) => {
                  const xs = SESSION_ORDER.map((s) => ({ s, v: metricValue(st[s], metric) })).filter(
                    (x): x is { s: string; v: number } => x.v !== null,
                  );
                  if (!xs.length) return null;
                  return xs.reduce((a, b) => ((metric === "depth" ? b.v > a.v : b.v < a.v) ? b : a));
                };
                return (
                  <li key={sym} className={styles.plate}>
                    <Link href={`/atlas/${sym}${q}`} className={styles.plateLink}>
                      <span className={styles.plateHead}>
                        <span className={styles.sym}>{sym}</span>
                        <span className={styles.plateMeta}>
                          {flags.length ? `${flags.length} flag${flags.length > 1 ? "s" : ""}` : ""}
                        </span>
                      </span>
                      <span className={styles.pair}>
                        {(
                          [
                            ["rtoken", `R${sym}USDT`, r],
                            ["perp", `${sym}USDT perp`, p],
                          ] as const
                        ).map(([v, name, st]) => {
                          const b = best(st);
                          return (
                            <span key={v} className={styles.venue}>
                              <Spiral
                                stats={st}
                                metric={metric}
                                id={`${sym}-${v}`}
                                label={`${sym} ${name}`}
                              />
                              <span className={styles.venueName}>{v === "rtoken" ? "rToken" : "Perp"}</span>
                              <span className={styles.venueNote}>
                                {b ? (
                                  <>
                                    <b>{formatMetric(b.v, metric)}</b> · {sessionLabel(b.s).toLowerCase()}
                                  </>
                                ) : (
                                  "none recorded"
                                )}
                              </span>
                              <span className={styles.venueNote}>
                                {sessions(st).length} of {new Set(WEEK_SPANS.map((w) => w.s)).size} sessions
                                recorded
                              </span>
                            </span>
                          );
                        })}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className={ui.caption}>
              <em>Medians of each session’s most recent recorded hours.</em> Depth is the notional per side
              within 25 bp of mid, from full-depth REST snapshots; spread and refill come from the 1-second
              top-15 books.
              <span className={ui.source}>{ATLAS_URL}</span>
            </p>

            <section className={ui.section} aria-labelledby="flags-h">
              <div className={styles.head}>
                <h2 className={ui.h2} id="flags-h">
                  Flags
                </h2>
                <p>
                  What the recorder found that a planner must not paper over. Each flag is published with the
                  atlas and changes what the desk will claim.
                </p>
              </div>
              <ul className={styles.flags}>
                <li className={styles.flag}>
                  <span className={styles.flagHead}>
                    <span className={live.ok ? styles.liveDot : styles.deadDot} aria-hidden="true" />
                    <strong>
                      Reality session labels {live.mismatch ? "disagree with" : "match"} New York time
                    </strong>
                    <span className={styles.flagCount}>live check</span>
                  </span>
                  <span>
                    {live.ok
                      ? `Bitget’s Reality states endpoint says daylightType “${live.label}”, time zone ${live.zones.join("/") || "?"}; New York is on ${live.nyZone} right now. ${
                          live.mismatch
                            ? "Slipway applies the session windows as New York wall clock through the IANA zone and never trusts the label."
                            : "Slipway still derives sessions from the IANA zone, not the label."
                        }`
                      : `The Reality states endpoint did not answer (${live.error}); sessions come from the IANA zone regardless.`}
                  </span>
                  <span className={ui.source}>
                    {live.url} · checked {nyTime(live.fetchedAt)}
                  </span>
                </li>
                {Object.entries(
                  parseFlags(atlas.data)
                    .filter((f) => f.type !== "METHOD")
                    .reduce<Record<string, Parsed[]>>((acc, f) => {
                      acc[f.type] ??= [];
                      acc[f.type]?.push(f);
                      return acc;
                    }, {}),
                ).map(([type, list]) => (
                  <li key={type} className={styles.flag}>
                    <span className={styles.flagHead}>
                      <strong>{flagTitle(type)}</strong>
                      <span className={styles.flagCount}>
                        {num(list.length)} key{list.length > 1 ? "s" : ""}
                      </span>
                    </span>
                    <span>{FLAG_INFO[type]?.text ?? list[0]?.text}</span>
                    <details className={ui.tableView}>
                      <summary>Every instance</summary>
                      <ul className={styles.flagList}>
                        {list.map((f) => (
                          <li key={`${f.key}|${f.text}`}>
                            <code>{f.key}</code> {f.text}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
              {parseFlags(atlas.data).some((f) => f.type === "METHOD") && (
                <div className={styles.method}>
                  <h3 className={styles.h3}>Method, as published with the atlas</h3>
                  <ul>
                    {parseFlags(atlas.data)
                      .filter((f) => f.type === "METHOD")
                      .map((f) => (
                        <li key={f.key + f.text}>
                          <strong>{f.key}:</strong> {f.text}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </section>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

type Parsed = ReturnType<typeof parseFlags>[number];
