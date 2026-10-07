import type { Metadata } from "next";
import Link from "next/link";
import { AccuracyGrid } from "@/components/record/AccuracyGrid";
import { Calibration } from "@/components/record/Calibration";
import { ForecastScatter, type ScatterPoint } from "@/components/record/ForecastScatter";
import { Forest } from "@/components/record/Forest";
import { LedgerCounts } from "@/components/record/LedgerCounts";
import { LightList } from "@/components/record/LightList";
import { comparisonLabel, forestRows, groupLabel, LABEL_TEXT } from "@/components/record/labels";
import page from "@/components/record/page.module.css";
import { ResidualStrip } from "@/components/record/ResidualStrip";
import { CodeBlock, TableView, Unavailable } from "@/components/site/Code";
import {
  getAnchorStatus,
  getGradeSample,
  getTrackRecord,
  LABELS,
  type Label,
  LISTING_BASE,
  PUBLIC_BASE,
  REPO_URL,
  TRACK_RECORD_URL,
} from "@/components/site/data";
import { Footer } from "@/components/site/Footer";
import { bp, num, nyTime, pct, sessionLabel, signedBp, utcTime, venueLabel } from "@/components/site/fmt";
import { Header } from "@/components/site/Header";
import ui from "@/components/site/ui.module.css";

export const revalidate = 60;
export const metadata: Metadata = {
  title: "Track record",
  description:
    "Every Slipway cost forecast is registered in a public hash-chained ledger before the tape prints, then graded against the recorded Bitget order book. Wins and losses.",
};

const GRADE_FILES = 72;

export default async function TrackRecordPage({
  searchParams,
}: {
  searchParams: Promise<{ label?: string }>;
}) {
  const sp = await searchParams;
  const label: Label = LABELS.includes(sp.label as Label) ? (sp.label as Label) : "REPRODUCIBLE";
  const [tr, sample, anchors] = await Promise.all([
    getTrackRecord(),
    getGradeSample(GRADE_FILES),
    getAnchorStatus(),
  ]);

  const points: ScatterPoint[] = sample.ok
    ? sample.data.points.flatMap((p) => {
        const r = p.realized[label];
        return typeof r === "number"
          ? [
              {
                a: p.at,
                f: Math.round(p.p50 * 100) / 100,
                r: Math.round(r * 100) / 100,
                lo: p.p10 === null ? null : Math.round(p.p10 * 100) / 100,
                hi: p.p90 === null ? null : Math.round(p.p90 * 100) / 100,
                v: p.venue,
                fam: p.family,
                h: p.horizon,
                s: p.symbol,
                se: p.session,
              },
            ]
          : [];
      })
    : [];
  const absErr = points.map((p) => Math.abs(p.r - p.f)).sort((a, b) => a - b);
  const within = (x: number) => absErr.filter((e) => e <= x).length;

  return (
    <>
      <Header current="track-record" />
      <main id="main" className={ui.page} data-paper>
        <section className={page.title}>
          <h1 className={ui.h1}>Track record</h1>
          <p className={ui.lede}>
            Every cost forecast Slipway makes is written to a public, hash-chained ledger before the market
            prints, then graded against the order book that actually printed. This page is rebuilt from that
            ledger; nothing on it is typed by hand, and the cases where Slipway loses are listed with the
            rest.
          </p>
          {tr.ok && (
            <dl className={page.facts}>
              <div>
                <dt>Protocol</dt>
                <dd>
                  {tr.data.protocol.name} v{tr.data.protocol.version}, fixed before data
                </dd>
              </div>
              <div>
                <dt>Protocol hash</dt>
                <dd className={page.hash}>{tr.data.protocol.hash}</dd>
              </div>
              <div>
                <dt>Graded through</dt>
                <dd>{nyTime(tr.data.tapeEnd)}</dd>
              </div>
              <div>
                <dt>Rebuilt</dt>
                <dd>{utcTime(tr.data.generatedAt)}</dd>
              </div>
            </dl>
          )}
        </section>

        {!tr.ok ? (
          <section className={ui.section}>
            <Unavailable what="The track record" url={tr.url} error={tr.error} />
          </section>
        ) : (
          <>
            <nav className={`${ui.filters} ${page.labelBar}`} aria-label="Grading assumption">
              <span>Grade own impact as</span>
              <span className={ui.seg}>
                {LABELS.map((l) => (
                  <Link
                    key={l}
                    href={l === "REPRODUCIBLE" ? "/track-record" : `/track-record?label=${l}`}
                    aria-current={l === label ? "true" : undefined}
                    scroll={false}
                  >
                    {l.charAt(0) + l.slice(1).toLowerCase()}
                  </Link>
                ))}
              </span>
              <span className={page.labelText}>{LABEL_TEXT[label]}</span>
            </nav>

            <section className={ui.section} aria-labelledby="ledger-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="ledger-h">
                  The ledger
                </h2>
                <p>
                  Every ten minutes the scheduler draws twelve orders with a fixed seed (symbol, size, side),
                  prices every strategy for each and registers the forecasts. A forecast is graded once its
                  slices have printed; if no recorded book is close enough in time or deep enough, it is
                  reported as ungraded, never imputed.
                </p>
              </div>
              {tr.data.counts.eval ? (
                <LedgerCounts counts={tr.data.counts.eval} reasons={tr.data.ungradedReasons} />
              ) : (
                <p className={ui.body}>The evaluation chain has no entries yet.</p>
              )}
              <p className={page.note}>
                {tr.data.counts.trader?.entries
                  ? `${num(tr.data.counts.trader.entries)} forecasts from plans built on the desk are in the trader ledger; ${num(tr.data.counts.trader.graded)} graded.`
                  : "Plans built on the desk go to a separate trader ledger; it has no graded entries yet, so everything below comes from the pre-registered evaluation."}
              </p>
            </section>

            <section className={ui.section} aria-labelledby="drift-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="drift-h">
                  Forecast against tape
                </h2>
                <p>
                  Each mark is one order: where Slipway said its cost would land, against what walking the
                  recorded book actually charged. Marks on the diagonal were called exactly; the faint whisker
                  is the forecast’s p10–p90 band.
                </p>
              </div>
              {!sample.ok ? (
                <Unavailable what="Per-forecast grades" url={sample.url} error={sample.error} />
              ) : points.length === 0 ? (
                <p className={ui.body}>No order-level forecast has been graded under this assumption yet.</p>
              ) : (
                <>
                  <figure className={ui.plate}>
                    <div className={ui.plateHead}>
                      <figcaption className={ui.plateTitle}>
                        Fig. 1 Predicted against verified, per order
                      </figcaption>
                      <ul className={ui.legend} aria-label="Legend">
                        <li>
                          <i
                            className={ui.ringKey}
                            style={{ color: "var(--venue-rtoken)", background: "var(--venue-rtoken)" }}
                          />
                          rToken
                        </li>
                        <li>
                          <i
                            className={ui.key}
                            style={{ background: "var(--venue-perp)", width: 10, height: 10 }}
                          />
                          perp
                        </li>
                      </ul>
                    </div>
                    <ForecastScatter points={points} label={label} />
                    <p className={ui.caption}>
                      <em>
                        {num(points.length)} graded orders, {num(within(1))} ({pct(within(1) / points.length)}
                        ) within 1 bp of the forecast, {num(within(5))} ({pct(within(5) / points.length)})
                        within 5 bp.
                      </em>{" "}
                      Costs in bp of arrival mid, fees included; positive is a cost to the trader. Sample:{" "}
                      {nyTime(sample.data.from)} to {nyTime(sample.data.to)}.
                      <span className={ui.source}>{sample.data.source}</span>
                    </p>
                  </figure>
                  <figure className={ui.plate}>
                    <div className={ui.plateHead}>
                      <figcaption className={ui.plateTitle}>
                        Fig. 2 Residuals over time, tape minus forecast
                      </figcaption>
                    </div>
                    <ResidualStrip points={points} />
                    <p className={ui.caption}>
                      <em>Above the line the tape charged more than forecast.</em> The histogram on the right
                      counts the same residuals.
                    </p>
                    <TableView
                      caption="Graded orders: forecast and realized cost"
                      head={[
                        "Time (ET)",
                        "Symbol",
                        "Venue",
                        "Strategy",
                        "Horizon",
                        "Forecast",
                        "p10",
                        "p90",
                        "Realized",
                      ]}
                      numeric={[5, 6, 7, 8]}
                      rows={points.map((p) => [
                        nyTime(p.a),
                        p.s,
                        venueLabel(p.v),
                        p.fam,
                        p.h,
                        bp(p.f, 2),
                        p.lo === null ? "" : bp(p.lo, 2),
                        p.hi === null ? "" : bp(p.hi, 2),
                        bp(p.r, 2),
                      ])}
                    />
                  </figure>
                </>
              )}
            </section>

            <section className={ui.section} aria-labelledby="acc-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="acc-h">
                  Accuracy by venue, session and horizon
                </h2>
                <p>
                  Mean absolute error of the median forecast, its bias (forecast minus tape: positive means
                  Slipway expected to pay more than it did) and how often the tape landed inside the p10–p90
                  band. A calibrated band holds about 80%; single market orders carry a point forecast, so
                  they count as covered only when the tape matches it exactly.
                </p>
              </div>
              <figure className={ui.plate}>
                <div className={ui.plateHead}>
                  <figcaption className={ui.plateTitle}>Fig. 3 Error per order, small multiples</figcaption>
                </div>
                <AccuracyGrid rows={tr.data.accuracy[label] ?? []} />
                <TableView
                  caption="Accuracy rows"
                  head={["Scope", "Venue", "Session", "Horizon", "n", "MAE", "Bias", "Coverage"]}
                  numeric={[4, 5, 6, 7]}
                  rows={(tr.data.accuracy[label] ?? []).map((r) => [
                    r.scope,
                    venueLabel(r.venue),
                    sessionLabel(r.session),
                    r.horizon,
                    num(r.n),
                    bp(r.maeBps, 2),
                    signedBp(r.biasBps, 2),
                    r.coverage ? `${pct(r.coverage.rate)} (${r.coverage.inside}/${r.coverage.n})` : "",
                  ])}
                />
              </figure>
            </section>

            <section className={ui.section} aria-labelledby="h2h-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="h2h-h">
                  Head to head
                </h2>
                <p>
                  The same pre-registered orders, three ways: Slipway’s chosen plan, one market order now, and
                  the 60-second TWAP a Bitget app user would reach for, each on the planner’s baseline venue.
                  Paired differences in realized cost, with seeded bootstrap 95% intervals.
                </p>
              </div>
              <figure className={ui.plate}>
                <div className={ui.plateHead}>
                  <figcaption className={ui.plateTitle}>
                    Fig. 4 Chosen plan minus baseline, {label.toLowerCase()}
                  </figcaption>
                </div>
                {forestRows(tr.data.headToHead[label]).length ? (
                  <Forest rows={forestRows(tr.data.headToHead[label])} />
                ) : (
                  <p className={ui.body}>No paired orders graded yet.</p>
                )}
                <TableView
                  caption="Head to head under every grading assumption"
                  head={["Assumption", "Baseline", "n", "Won", "Lost", "Tied", "Mean diff", "95% CI"]}
                  numeric={[2, 3, 4, 5, 6]}
                  rows={LABELS.flatMap((l) =>
                    (["vsImmediate", "vsTwap60"] as const).flatMap((k) => {
                      const c = tr.data.headToHead[l]?.[k];
                      return c
                        ? [
                            [
                              l,
                              k === "vsImmediate" ? "immediate" : "TWAP-60",
                              num(c.n),
                              num(c.wins),
                              num(c.losses),
                              num(c.ties),
                              signedBp(c.meanDiffBps),
                              `${signedBp(c.ci95[0])} to ${signedBp(c.ci95[1])}`,
                            ],
                          ]
                        : [];
                    }),
                  )}
                />
              </figure>
              <div className={page.losses}>
                <h3 className={page.h3}>Where Slipway loses</h3>
                {tr.data.losses.length ? (
                  <ul>
                    {tr.data.losses.map((l) => {
                      const c = comparisonLabel(l.comparison);
                      return (
                        <li
                          key={`${l.comparison}|${l.group}`}
                          className={c.label === label ? page.lossOn : undefined}
                        >
                          <span className={page.lossWhat}>
                            Against {c.baseline} on <strong>{groupLabel(l.group)}</strong>
                          </span>
                          <span className={page.lossNum}>{signedBp(l.meanDiffBps)}</span>
                          <span className={page.lossMeta}>
                            {num(l.n)} order{l.n === 1 ? "" : "s"} · 95% CI {signedBp(l.ci95[0])} to{" "}
                            {signedBp(l.ci95[1])} · {c.label?.toLowerCase() ?? ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className={ui.body}>No group where the chosen plan cost more on average, so far.</p>
                )}
                <p className={page.note}>
                  A loss is any group (size, symbol, session) where the chosen plan’s mean realized cost was
                  above the baseline’s. Small groups are listed too; read their intervals.
                </p>
              </div>
            </section>

            <section className={ui.section} aria-labelledby="cal-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="cal-h">
                  Calibration, before and after
                </h2>
                <p>
                  {(() => {
                    const rows = tr.data.calibration[label] ?? [];
                    const worse = rows.filter((r) => r.maeCalibratedBps > r.maeRawBps).length;
                    return rows.length
                      ? `Per venue and session, a multiplicative factor is fitted on earlier outcomes (shrunk toward 1) and scored only on forecasts registered later. So far it made the error worse in ${worse} of ${rows.length} cells.`
                      : "No calibration factor has been fitted yet.";
                  })()}
                </p>
              </div>
              <figure className={ui.plate}>
                <div className={ui.plateHead}>
                  <figcaption className={ui.plateTitle}>
                    Fig. 5 Out-of-sample error with and without the factor
                  </figcaption>
                </div>
                <Calibration rows={tr.data.calibration[label] ?? []} />
              </figure>
            </section>

            <section className={ui.section} aria-labelledby="light-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="light-h">
                  The Light List
                </h2>
                <p>
                  Each data source, removed one at a time: the planner re-runs on the same saved snapshots
                  with the source replaced by its documented fallback. How many chosen plans change, and what
                  the replacement plans would have cost on the recorded tape. Sources that made things worse
                  are listed as such.
                </p>
              </div>
              {tr.data.ablation ? (
                <figure className={ui.plate}>
                  <div className={ui.plateHead}>
                    <figcaption className={ui.plateTitle}>Fig. 6 What each source changed</figcaption>
                  </div>
                  <LightList sources={tr.data.ablation.sources} />
                  <p className={ui.caption}>
                    <em>
                      {num(tr.data.ablation.orders)} orders from {num(tr.data.ablation.batches)} batches;{" "}
                      {num(tr.data.ablation.replayMatchesRegistered)} of {num(tr.data.ablation.orders)}{" "}
                      replays reproduced the registered plan exactly.
                    </em>{" "}
                    Cost effect = realized cost of the plan chosen without the source minus the plan chosen
                    with it, on the orders whose plan changed, graded reproducible.
                  </p>
                </figure>
              ) : (
                <p className={ui.body}>The ablation has not run yet.</p>
              )}
            </section>

            <section className={ui.section} aria-labelledby="anchor-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="anchor-h">
                  Anchoring
                </h2>
                <p>
                  The ledger is hash-chained, so editing any past entry breaks every hash after it. An
                  on-chain anchor would add an outside timestamp: a Merkle root of new entries posted to
                  Arbitrum One before their outcomes print.
                </p>
              </div>
              <div className={page.anchor}>
                <p className={page.anchorStatus}>
                  {anchors.deployed ? (
                    <>
                      <strong>Anchored on Arbitrum One.</strong>{" "}
                      {num(tr.data.anchoring.anchoredBeforeOutcome)} graded forecasts were anchored before
                      their outcome; {num(tr.data.anchoring.ledgerTimestampedOnly)} are ledger-timestamped
                      only. {num(anchors.files)} anchor files are public.
                    </>
                  ) : (
                    <>
                      <strong>Ledger-timestamped only.</strong> The anchor contract is not deployed yet, so
                      none of the{" "}
                      {num(tr.data.anchoring.ledgerTimestampedOnly + tr.data.anchoring.anchoredBeforeOutcome)}{" "}
                      graded forecasts carries an on-chain timestamp. Their only proof of timing is the hash
                      chain and the storage write times.
                    </>
                  )}
                </p>
                <span className={ui.source}>
                  {PUBLIC_BASE}/anchors/config.json {anchors.deployed ? "" : "· not found"}
                  {anchors.error ? ` · ${anchors.error}` : ""}
                </span>
              </div>
            </section>

            <section className={ui.section} aria-labelledby="verify-h">
              <div className={page.head}>
                <h2 className={ui.h2} id="verify-h">
                  Verify it yourself
                </h2>
                <p>
                  No account, no keys. The verifier downloads the public ledger, checks both hash chains and
                  every plan signature, checks anchors against the chain when there are any, re-grades a
                  random sample of forecasts from the public tape, and runs negative controls that must fail.
                </p>
              </div>
              <div className={page.verify}>
                <CodeBlock
                  title="shell"
                  code={`git clone ${REPO_URL}\ncd slipway && pnpm install\npnpm verify`}
                />
                <ul className={page.links}>
                  <li>
                    <span>Protocol (committed before data)</span>
                    <a href={`${REPO_URL}/blob/main/eval/protocol.json`}>eval/protocol.json</a>
                    <code>{tr.data.protocol.hash}</code>
                  </li>
                  <li>
                    <span>Forecast ledger, hash-chained JSONL</span>
                    <a href={`${LISTING_BASE}?prefix=ledger/eval/`}>ledger/eval/</a>
                  </li>
                  <li>
                    <span>Per-forecast grades</span>
                    <a href={`${LISTING_BASE}?prefix=grades/eval/`}>grades/eval/</a>
                  </li>
                  <li>
                    <span>Batch manifests and snapshots</span>
                    <a href={`${LISTING_BASE}?prefix=eval/`}>eval/</a>
                  </li>
                  <li>
                    <span>Recorded tape</span>
                    <a href={`${LISTING_BASE}?prefix=tape/`}>tape/</a>
                  </li>
                  <li>
                    <span>This page’s data</span>
                    <a href={TRACK_RECORD_URL}>derived/track-record.json</a>
                  </li>
                </ul>
              </div>
              {tr.data.notes.length > 0 && (
                <div className={page.notes}>
                  <h3 className={page.h3}>Method notes, as published with the data</h3>
                  <ol>
                    {tr.data.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ol>
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
