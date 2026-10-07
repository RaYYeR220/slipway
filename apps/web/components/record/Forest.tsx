import { num, signedBp } from "../site/fmt";
import { ticks } from "../site/scale";
import styles from "./record.module.css";

export interface ForestRow {
  key: string;
  label: string;
  sub?: string;
  mean: number;
  lo: number;
  hi: number;
  wins?: number;
  losses?: number;
  ties?: number;
}

/**
 * Mean difference with a 95% interval per row, on one shared axis. Negative = Slipway's plan cost less.
 * HTML + CSS positioning, so marks stay round and text stays legible at any width.
 */
export function Forest({
  rows,
  axisLabel = "Realized cost difference, chosen plan minus baseline",
  leftLabel = "Slipway cheaper",
  rightLabel = "baseline cheaper",
}: {
  rows: ForestRow[];
  axisLabel?: string;
  leftLabel?: string;
  rightLabel?: string;
}) {
  const xs = rows.flatMap((r) => [r.lo, r.hi, r.mean]).filter(Number.isFinite);
  let lo = Math.min(0, ...xs);
  let hi = Math.max(0, ...xs);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const tv = ticks(lo, hi, 5);
  const at = (v: number) => `${(((v - lo) / (hi - lo)) * 100).toFixed(3)}%`;
  return (
    <div className={styles.forest}>
      {rows.map((r) => (
        <div className={styles.fRow} key={r.key}>
          <div className={styles.fLabel}>
            <span className={styles.fName}>{r.label}</span>
            {r.sub && <span className={styles.fSub}>{r.sub}</span>}
          </div>
          <div className={styles.fTrack}>
            <span className={styles.fZero} style={{ left: at(0) }} aria-hidden="true" />
            <span
              className={styles.fCi}
              style={{
                left: at(Math.min(r.lo, r.hi)),
                width: `calc(${at(Math.max(r.lo, r.hi))} - ${at(Math.min(r.lo, r.hi))})`,
              }}
              aria-hidden="true"
            />
            <span className={styles.fDot} style={{ left: at(r.mean) }} aria-hidden="true" />
          </div>
          <div className={styles.fValue}>
            <strong>{signedBp(r.mean)}</strong>
            <span>
              95% CI {signedBp(r.lo)} to {signedBp(r.hi)}
            </span>
            {r.wins !== undefined && (
              <span>
                {num(r.wins)} won · {num(r.losses ?? 0)} lost · {num(r.ties ?? 0)} tied
              </span>
            )}
          </div>
        </div>
      ))}
      <div className={styles.fRow} aria-hidden="true">
        <div />
        <div className={styles.fAxis}>
          {tv.map((t) => (
            <span key={t} style={{ left: at(t) }}>
              {t > 0 ? `+${t}` : t < 0 ? `−${Math.abs(t)}` : "0"}
            </span>
          ))}
        </div>
        <div />
      </div>
      <div className={styles.fRow}>
        <div />
        <div className={styles.fDirs}>
          <span>← {leftLabel}</span>
          <span>{rightLabel} →</span>
        </div>
        <div />
      </div>
      <p className={styles.fCaption}>{axisLabel}, bp of arrival mid.</p>
    </div>
  );
}
