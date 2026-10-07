import type { Counts } from "../site/data";
import { num, pct } from "../site/fmt";
import styles from "./record.module.css";

const PARTS = [
  { key: "graded", label: "Graded", note: "outcome walked on the recorded book" },
  { key: "ungraded", label: "Ungraded", note: "no fair book to grade against, reported below" },
  { key: "pending", label: "Pending", note: "outcome time not reached, or not yet graded" },
] as const;

/** The ledger as one bar: every registered forecast is graded, ungraded (with a reason) or pending. */
export function LedgerCounts({ counts, reasons }: { counts: Counts; reasons: Record<string, number> }) {
  const total = counts.entries || 1;
  const rs = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  const rmax = Math.max(1, ...rs.map((r) => r[1]));
  return (
    <div className={styles.ledger}>
      <p className={styles.ledgerTotal}>
        <strong>{num(counts.entries)}</strong> forecasts registered in the evaluation ledger
      </p>
      <div
        className={styles.ledgerBar}
        role="img"
        aria-label={PARTS.map((p) => `${p.label} ${num(counts[p.key])}`).join(", ")}
      >
        {PARTS.map((p) =>
          counts[p.key] > 0 ? (
            <span
              key={p.key}
              className={`${styles.seg} ${styles[`seg_${p.key}`]}`}
              style={{ flexGrow: counts[p.key] / total }}
            />
          ) : null,
        )}
      </div>
      <ul className={styles.ledgerKeys}>
        {PARTS.map((p) => (
          <li key={p.key}>
            <i className={`${styles.segKey} ${styles[`seg_${p.key}`]}`} aria-hidden="true" />
            <span className={styles.ledgerNum}>{num(counts[p.key])}</span>
            <span>
              {p.label.toLowerCase()} · {pct(counts[p.key] / total)} · {p.note}
            </span>
          </li>
        ))}
      </ul>
      {rs.length > 0 && (
        <div className={styles.reasons}>
          <h3 className={styles.subhead}>Why forecasts went ungraded</h3>
          <ul>
            {rs.map(([reason, n]) => (
              <li key={reason}>
                <span className={styles.reasonText}>{reason}</span>
                <span className={styles.reasonBar}>
                  <span style={{ width: `${(n / rmax) * 100}%` }} />
                </span>
                <span className={styles.reasonNum}>{num(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
