import { Decide } from "@/components/landing/Decide";
import { Grades } from "@/components/landing/Grades";
import { Hero } from "@/components/landing/Hero";
import styles from "@/components/landing/landing.module.css";
import { PlugIn } from "@/components/landing/PlugIn";
import { Sourced } from "@/components/landing/Sourced";
import { WeekStrip } from "@/components/landing/WeekStrip";
import { TableView } from "@/components/site/Code";
import { getAtlas, getTrackRecord } from "@/components/site/data";
import { Footer } from "@/components/site/Footer";
import { usd } from "@/components/site/fmt";
import { Header } from "@/components/site/Header";
import { HOW, HOW_PUBLIC_PATH, shortDate, weekdayMedian, weekendRange } from "@/components/site/how";
import ui from "@/components/site/ui.module.css";

export const revalidate = 60;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function Home() {
  const [tr, atlas] = await Promise.all([getTrackRecord(), getAtlas()]);
  const nv = HOW.series.NVDA;
  const r = nv?.rtoken ?? null;
  const p = nv?.perp ?? null;
  const reg = r ? weekdayMedian(r.vol, 10, 16) : null;
  const night = r ? weekdayMedian(r.vol, 0, 4) : null;
  const ratio = reg !== null && night ? Math.round(reg / night) : null;
  const wk = r ? weekendRange(r.vol) : null;
  const pwk = p ? weekendRange(p.vol) : null;
  const span = r ? `${shortDate(r.from)} – ${shortDate(r.to)} ${new Date(r.to).getUTCFullYear()}` : "";
  const heroSource = r
    ? `rNVDA median USDT per hour, 10:00–16:00 vs 00:00–04:00 ET weekdays, Bitget 1h candles ${span}`
    : "";

  return (
    <>
      <Header overlay />
      <main id="main">
        <Hero
          vol={r ? r.vol.map((v) => v ?? 0) : []}
          rng={r ? r.rng.map((v) => v ?? 0) : []}
          ratio={ratio}
          source={heroSource}
          weeks={r ? Math.max(1, Math.round((r.to - r.from) / (7 * 86_400_000))) : undefined}
        />
        <div className={ui.page}>
          <section className={ui.section} aria-labelledby="problem-h">
            <div className={styles.head}>
              <h2 className={ui.h2} id="problem-h">
                Open all week. Deep for a few hours of it.
              </h2>
              <div>
                <p>
                  Bitget quotes rNVDA around the clock, but the money behind it keeps New York hours. The
                  value printed against the rToken mirrors the US tape: {usd(reg)} in a typical
                  regular-session hour, {wk ? `${usd(wk.min)} to ${usd(wk.max)}` : "a trickle"} in a weekend
                  hour.
                </p>
                <p>
                  The NVDA perp trades on Bitget’s own book: flatter, thinner, and on weekends{" "}
                  {pwk ? `${usd(pwk.min)} to ${usd(pwk.max)}` : "still open"} an hour. The same order costs a
                  different amount depending on when and where it crosses.
                </p>
              </div>
            </div>
            {r ? (
              <figure className={ui.plate}>
                <div className={ui.plateHead}>
                  <figcaption className={ui.plateTitle}>
                    Traded value per hour across the New York week
                  </figcaption>
                  <ul className={ui.legend} aria-label="Legend">
                    <li>
                      <i className={ui.key} style={{ background: "var(--venue-rtoken)" }} />
                      rNVDA (mirrors routed US volume)
                    </li>
                    {p && (
                      <li>
                        <i className={ui.lineKey} style={{ background: "var(--venue-perp)" }} />
                        NVDA perp (Bitget-native)
                      </li>
                    )}
                  </ul>
                </div>
                <WeekStrip
                  rtoken={r.vol}
                  perp={p ? p.vol : null}
                  weeks={r.weeks}
                  rtokenName="rNVDA"
                  perpName="NVDA perp"
                />
                <p className={ui.caption}>
                  <em>Median USDT per hour, log scale.</em> The week opens Sunday 20:00 New York, when
                  overnight trading starts; the hatched span is the weekend. The teal line is now.
                  <span className={ui.source}>
                    {r.symbol} and {p?.symbol ?? "perp"} 1h candles, {HOW.source.endpoint}, {span}; median per
                    New York hour-of-week · <a href={HOW_PUBLIC_PATH}>{HOW_PUBLIC_PATH}</a> (generated{" "}
                    {HOW.generatedAt.slice(0, 10)})
                  </span>
                </p>
                <TableView
                  caption="Median USDT traded per hour, by New York hour of the week"
                  head={["Hour (ET)", "rNVDA", "NVDA perp", "Weeks"]}
                  numeric={[1, 2, 3]}
                  rows={r.vol.map((v, i) => [
                    `${DAYS[Math.floor(i / 24)]} ${String(i % 24).padStart(2, "0")}:00`,
                    usd(v),
                    usd(p?.vol[i] ?? null),
                    String(r.weeks[i] ?? 0),
                  ])}
                />
              </figure>
            ) : (
              <p className={ui.unavailable}>
                The hourly candle series for rNVDA is missing from {HOW_PUBLIC_PATH}.
              </p>
            )}
          </section>

          <section className={ui.section} aria-labelledby="decide-h">
            <div className={styles.head}>
              <h2 className={ui.h2} id="decide-h">
                Four ways across. One gate before the ticket.
              </h2>
              <div>
                <p>
                  Once you have decided what to buy, Slipway prices every way of getting it done against the
                  live Bitget book: which venue, which session, how many slices. Each path gets an expected
                  cost and a band around it, so a cheap-but-risky wait competes fairly with a sure-but-dear
                  fill now.
                </p>
              </div>
            </div>
            <Decide />
          </section>

          <section className={ui.section} aria-labelledby="grades-h">
            <div className={styles.head}>
              <h2 className={ui.h2} id="grades-h">
                It grades itself, in public.
              </h2>
              <div>
                <p>
                  Every ten minutes a scheduler registers a fixed-seed batch of orders and Slipway’s cost
                  forecast for each path, in a hash-chained ledger, before the tape prints. When the slices’
                  times pass, a grader walks the order book that actually printed and scores the forecast.
                  Wins and losses are both published.
                </p>
              </div>
            </div>
            <Grades tr={tr} />
          </section>

          <section className={ui.section} aria-labelledby="sourced-h">
            <div className={styles.head}>
              <h2 className={ui.h2} id="sourced-h">
                The model writes the words. Code writes the numbers.
              </h2>
              <div>
                <p>
                  The language model on the desk never types a digit. It writes slots; code fills each one
                  from a named source and keeps the source beside it. If a numeral slips into the model’s text
                  anyway, it is masked and flagged before you see it.
                </p>
              </div>
            </div>
            <Sourced atlas={atlas} />
          </section>

          <section className={ui.section} aria-labelledby="plug-h">
            <div className={styles.head}>
              <h2 className={ui.h2} id="plug-h">
                Plug it into your own agent.
              </h2>
              <div>
                <p>
                  The desk is one service with four doors: the same tools over MCP, as a Bitget-format Skill,
                  through a typed SDK, or as plain HTTP. No keys: market data comes from Bitget’s public
                  endpoints and tickets are dry runs.
                </p>
              </div>
            </div>
            <PlugIn />
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
