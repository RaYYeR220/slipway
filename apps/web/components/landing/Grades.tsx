import Link from "next/link";
import { Forest } from "../record/Forest";
import { comparisonLabel, forestRows, groupLabel, lossesFor } from "../record/labels";
import { Unavailable } from "../site/Code";
import type { Fetched, TrackRecord } from "../site/data";
import { num, signedBp, utcTime } from "../site/fmt";
import ui from "../site/ui.module.css";
import styles from "./landing.module.css";

export function Grades({ tr }: { tr: Fetched<TrackRecord> }) {
  if (!tr.ok) return <Unavailable what="The track record" url={tr.url} error={tr.error} />;
  const t = tr.data;
  const label = t.primaryLabel || "REPRODUCIBLE";
  const rows = forestRows(t.headToHead[label]);
  const losses = lossesFor(t.losses, label);
  const ev = t.counts.eval;
  return (
    <div className={styles.grades}>
      {ev && (
        <p className={styles.liveCount}>
          <span className={styles.liveDot} aria-hidden="true" />
          <strong>{num(ev.entries)}</strong> forecasts registered before their tape printed;{" "}
          <strong>{num(ev.graded)}</strong> graded so far.
        </p>
      )}
      <figure className={ui.plate}>
        <div className={ui.plateHead}>
          <figcaption className={ui.plateTitle}>
            Slipway’s chosen plan against the two plans a trader would default to
          </figcaption>
        </div>
        {rows.length ? (
          <Forest rows={rows} />
        ) : (
          <p className={ui.body}>No paired orders have been graded yet.</p>
        )}
        <div className={styles.losses}>
          <h3 className={ui.h3}>Where it loses</h3>
          {losses.length ? (
            <ul>
              {losses.map((l) => (
                <li key={`${l.comparison}-${l.group}`}>
                  Against {comparisonLabel(l.comparison).baseline} on <strong>{groupLabel(l.group)}</strong>:{" "}
                  {signedBp(l.meanDiffBps)} on average over {num(l.n)} order{l.n === 1 ? "" : "s"} (95% CI{" "}
                  {signedBp(l.ci95[0])} to {signedBp(l.ci95[1])}).
                </li>
              ))}
            </ul>
          ) : (
            <p>No group where the chosen plan cost more on average, so far.</p>
          )}
        </div>
        <p className={ui.caption}>
          <em>Graded {label.toLowerCase()}:</em> each slice is a shadow fill, walked on the recorded book as
          it printed. Positive means Slipway paid more. Intervals are seeded bootstrap 95% CIs.
          <span className={ui.source}>
            {tr.url} · generated {utcTime(t.generatedAt)} · protocol {t.protocol.hash.slice(0, 12)}…
          </span>
        </p>
      </figure>
      <p className={styles.more}>
        The full record breaks accuracy down by venue, session and horizon, shows calibration and what each
        data source changed, and tells you how to re-grade it yourself.{" "}
        <Link className={ui.textLink} href="/track-record">
          Open the track record
        </Link>
      </p>
    </div>
  );
}
