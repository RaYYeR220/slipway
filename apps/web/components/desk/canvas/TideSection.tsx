"use client";
import { useEffect, useRef } from "react";
import { age, sessionLabel, usdCompact, venueName } from "@/lib/desk/format";
import { tradingWeek } from "@/lib/desk/ny";
import type {
  ApiFailure,
  Held,
  OptionsData,
  PlanData,
  SessionStats,
  TideData,
  Venue,
} from "@/lib/desk/types";
import { useNow } from "../../charts/hooks";
import { TEMPO } from "../../charts/ramps";
import { Tide, type TideWindow } from "../../charts/Tide";
import c from "./canvas.module.css";
import { Failure, SectionHead, Working } from "./parts";

interface Props {
  symbol: string;
  tide: Held<TideData> | null;
  options: Held<OptionsData> | null;
  plan: Held<PlanData> | null;
  busy: boolean;
  error: ApiFailure | undefined;
  light: boolean;
  reduced: boolean;
}

export function TideSection({ symbol, tide, options, plan, busy, error, light, reduced }: Props) {
  const now = useNow(30_000);
  const scroller = useRef<HTMLDivElement | null>(null);
  const t = tide?.data ?? null;

  // On narrow screens the week scrolls sideways: start with "now" in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !t || el.scrollWidth <= el.clientWidth + 4) return;
    const wk = tradingWeek(t.now);
    const frac = Math.max(0, Math.min(1, (t.now - wk.start) / (wk.end - wk.start)));
    el.scrollLeft = Math.max(0, el.scrollWidth * frac - el.clientWidth * 0.4);
  }, [t]);

  const slices = plan?.data.slices ?? null;
  const best = options?.data.best ?? null;
  const win: TideWindow | null =
    !slices && best ? { start: best.startsAt, end: best.endsAt, label: best.kind } : null;
  const deadline = plan?.data.intent.deadline ?? options?.data.intent.deadline ?? null;

  const atlas = t?.atlas;
  const aside = atlas ? (
    <span className={c.status} data-status={atlas.status}>
      atlas {atlas.status}
      {atlas.asOf ? `, built ${age(now - atlas.asOf)} ago` : ""}
      {atlas.detail ? ` (${atlas.detail})` : ""}
    </span>
  ) : null;

  return (
    <section className={c.section} aria-labelledby="h-tide" id="desk-tide">
      <SectionHead
        id="h-tide"
        title="Liquidity tide"
        lede={
          <>
            The week ahead for {symbol}, Sunday 20:00 to Friday 20:00 New York. rToken water runs above the
            line, perp water below; height is the depth within ±25 bp of mid in that session, brighter means a
            tighter spread.
            {slices
              ? " The dots are your plan's slices, released at their scheduled time."
              : best
                ? " The bracket is the best plan's execution window."
                : ""}
          </>
        }
        aside={aside}
      />
      {t ? (
        <>
          <div className={c.tideScroll} ref={scroller}>
            <div className={c.tideInner}>
              <Tide
                tide={t}
                now={now}
                slices={slices}
                window={win}
                deadline={deadline ?? null}
                light={light}
                reduced={reduced}
              />
            </div>
          </div>
          <TideKey />
          <TideTable tide={t} />
        </>
      ) : busy ? (
        <Working
          text={`Reading the ${symbol} atlas: depth and spread for every session of the week, against the live books…`}
        />
      ) : error ? (
        <Failure error={error} what="The tide is unavailable" />
      ) : null}
    </section>
  );
}

function TideKey() {
  return (
    <div className={c.tideKey}>
      <span className={c.keyItem}>
        <span
          className={c.keyRamp}
          style={{ background: `linear-gradient(90deg, ${TEMPO.slice(2, 9).join(",")})` }}
        />
        wide spread to tight
      </span>
      <span className={c.keyItem}>
        <span className={c.keyNow} />
        now, live book
      </span>
      <span className={c.keyItem}>
        <span className={c.keyHatch} />
        session not sampled by the atlas yet
      </span>
    </div>
  );
}

const ORDER = ["pre_market", "regular", "after_hours", "overnight", "weekend"];

function Cell({ st, tradable }: { st: SessionStats; tradable: boolean }) {
  if (!tradable) return <td className={c.tdMuted}>closed</td>;
  if (!st) return <td className={c.tdMuted}>no sample</td>;
  return (
    <td>
      <span className={c.cellMain}>{usdCompact(st.depth25UsdP50)}</span>
      <span className={c.cellSub}>
        {st.spreadBpsP50.toFixed(2)} bp, n {st.n.toLocaleString("en-US")}
      </span>
    </td>
  );
}

function TideTable({ tide }: { tide: TideData }) {
  const rows = [...tide.bySession].sort((a, b) => ORDER.indexOf(a.session) - ORDER.indexOf(b.session));
  const trad = (sess: string, v: Venue) =>
    tide.timeline.find((x) => x.session === sess)?.venues[v].tradable ?? true;
  return (
    <div className={c.tableScroll}>
      <table className={c.table}>
        <caption className={c.sr}>
          Depth within ±25 bp of mid (atlas median per session) and median spread, by venue and session
        </caption>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col" className={c.thLive}>
              now, live
            </th>
            {rows.map((r) => (
              <th scope="col" key={r.session}>
                {sessionLabel(r.session)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(["rtoken", "perp"] as Venue[]).map((v) => {
            const lv = tide.live.venues[v];
            return (
              <tr key={v}>
                <th scope="row">{venueName(v, tide.symbol)}</th>
                {lv ? (
                  <td className={c.tdLive}>
                    <span className={c.cellMain}>{usdCompact(lv.depth25Usd)}</span>
                    <span className={c.cellSub}>{lv.spreadBps.toFixed(2)} bp</span>
                  </td>
                ) : (
                  <td className={c.tdMuted}>no book</td>
                )}
                {rows.map((r) => (
                  <Cell key={r.session} st={r[v]} tradable={trad(r.session, v)} />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
