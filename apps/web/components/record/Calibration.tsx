import type { CalibrationRow } from "../site/data";
import { bp, num, sessionLabel, signedBp, venueLabel } from "../site/fmt";
import { ticks } from "../site/scale";
import styles from "./record.module.css";

/** Dumbbells: out-of-sample MAE before (ring) and after (dot) the per-key calibration factor. */
export function Calibration({ rows }: { rows: CalibrationRow[] }) {
  if (!rows.length) return <p className={styles.empty}>No calibration factor has been fitted yet.</p>;
  const hi = Math.max(...rows.flatMap((r) => [r.maeRawBps, r.maeCalibratedBps])) * 1.15;
  const at = (v: number) => `${((v / hi) * 100).toFixed(3)}%`;
  const tv = ticks(0, hi, 4);
  return (
    <div className={styles.cal}>
      {rows.map((r) => {
        const d = r.maeCalibratedBps - r.maeRawBps;
        const lo = Math.min(r.maeRawBps, r.maeCalibratedBps);
        const hiv = Math.max(r.maeRawBps, r.maeCalibratedBps);
        return (
          <div key={`${r.venue}|${r.session}`} className={styles.calRow}>
            <div className={styles.fLabel}>
              <span className={styles.fName}>
                {venueLabel(r.venue)}, {sessionLabel(r.session).toLowerCase()}
              </span>
              <span className={styles.fSub}>
                k {r.k.toFixed(3)} · n {num(r.evalN)}
              </span>
            </div>
            <div className={styles.fTrack}>
              <span
                className={styles.calSpan}
                style={{ left: at(lo), width: `calc(${at(hiv)} - ${at(lo)})` }}
              />
              <span
                className={styles.calRaw}
                style={{ left: at(r.maeRawBps) }}
                title={`before ${bp(r.maeRawBps, 2)}`}
              />
              <span
                className={styles.calCal}
                style={{ left: at(r.maeCalibratedBps) }}
                title={`after ${bp(r.maeCalibratedBps, 2)}`}
              />
            </div>
            <div className={styles.fValue}>
              <strong>
                {bp(r.maeRawBps, 2)} → {bp(r.maeCalibratedBps, 2)}
              </strong>
              <span className={d > 0 ? styles.worse : styles.better}>
                {d > 0 ? "worse" : d < 0 ? "better" : "unchanged"} by {signedBp(d, 2).replace(/^[+−]/, "")}
              </span>
            </div>
          </div>
        );
      })}
      <div className={styles.calRow} aria-hidden="true">
        <div />
        <div className={styles.fAxis}>
          {tv.map((t) => (
            <span key={t} style={{ left: at(t) }}>
              {t}
            </span>
          ))}
        </div>
        <div />
      </div>
      <ul className={styles.calKeys}>
        <li>
          <i className={styles.calRawKey} aria-hidden="true" /> raw forecast
        </li>
        <li>
          <i className={styles.calCalKey} aria-hidden="true" /> after calibration
        </li>
        <li>mean absolute error, bp</li>
      </ul>
    </div>
  );
}
