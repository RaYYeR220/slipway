import type { AblationRow } from "../site/data";
import { bp, num, pct, signedBp } from "../site/fmt";
import { ticks } from "../site/scale";
import styles from "./record.module.css";

type Effect = "saved" | "worse" | "none" | "ungraded";

function effect(r: AblationRow): Effect {
  if (r.changed === 0) return "none";
  if (!r.deltaRealizedBps) return "ungraded";
  return r.deltaRealizedBps.mean > 0 ? "saved" : "worse";
}

/** A light: rays when the source changed plans, colour + word for what that did to realized cost. */
function Light({ e }: { e: Effect }) {
  const c = e === "saved" ? "var(--allow)" : e === "worse" ? "var(--refuse)" : "var(--faint)";
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <circle
        cx="12"
        cy="12"
        r="4.5"
        style={{ fill: e === "none" ? "none" : c, stroke: c }}
        strokeWidth="1.4"
      />
      {e !== "none" &&
        [0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <line
            key={a}
            x1="12"
            y1="3"
            x2="12"
            y2="5.5"
            transform={`rotate(${a} 12 12)`}
            style={{ stroke: c }}
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        ))}
    </svg>
  );
}

const SOURCE_NAME: Record<string, string> = {
  "bitget.spot.orderbook": "Live rToken order book",
  "bitget.mix.orderbook": "Live perp order book",
  "atlas.resilience": "Measured book refill (half-life)",
  "atlas.flow": "Recorded trade flow",
  "atlas.representativeBook": "Representative book per session",
  "atlas.gapSigma": "Gap risk across sessions",
  "atlas.basisSigma": "Perp–rToken basis risk",
  "bitget.mix.funding": "Perp funding",
  "bitget.reality.calendar": "Reality holiday calendar",
};
const nameOf = (s: string) => SOURCE_NAME[s] ?? (s.startsWith("events") ? "Event windows" : s);

/**
 * The Light List: every data source, removed one at a time from the same pre-registered orders.
 * Effect = (realized cost without the source) − (realized cost with it), on the orders whose plan changed.
 */
export function LightList({ sources }: { sources: AblationRow[] }) {
  const rows = [...sources].sort(
    (a, b) => b.changedShare - a.changedShare || a.source.localeCompare(b.source),
  );
  const ext = rows.flatMap((r) =>
    r.deltaRealizedBps ? [r.deltaRealizedBps.ci95[0], r.deltaRealizedBps.ci95[1]] : [],
  );
  const a = Math.max(2, ...ext.map(Math.abs)) * 1.1;
  const at = (v: number) => `${(((v + a) / (2 * a)) * 100).toFixed(3)}%`;
  const tv = ticks(-a, a, 4);
  return (
    <div className={styles.lights}>
      <div className={`${styles.lightRow} ${styles.lightHead}`} aria-hidden="true">
        <span />
        <span>Source, and what replaces it when removed</span>
        <span>Plans it changed</span>
        <span>Realized cost of those plans</span>
      </div>
      {rows.map((r) => {
        const e = effect(r);
        const dr = r.deltaRealizedBps;
        const de = r.deltaAbsErrorBps;
        return (
          <div key={r.source} className={`${styles.lightRow} ${e === "none" ? styles.lightDim : ""}`}>
            <span className={styles.lightGlyph}>
              <Light e={e} />
            </span>
            <span className={styles.lightName}>
              <strong>{nameOf(r.source)}</strong>
              <code>{r.source}</code>
              <span>Without it: {r.fallback}.</span>
            </span>
            <span className={styles.lightShare}>
              <span className={styles.meter} aria-hidden="true">
                <span style={{ width: `${Math.max(r.changedShare * 100, r.changed ? 1 : 0)}%` }} />
              </span>
              <span>
                {pct(r.changedShare, r.changedShare > 0 && r.changedShare < 0.1 ? 1 : 0)} · {num(r.changed)}{" "}
                of {num(r.orders)} orders
              </span>
            </span>
            <span className={styles.lightEffect}>
              {dr ? (
                <>
                  <span className={styles.lightTrack} aria-hidden="true">
                    <span className={styles.fZero} style={{ left: at(0) }} />
                    <span
                      className={styles.fCi}
                      style={{ left: at(dr.ci95[0]), width: `calc(${at(dr.ci95[1])} - ${at(dr.ci95[0])})` }}
                    />
                    <span
                      className={`${styles.fDot} ${e === "worse" ? styles.dotWorse : styles.dotSaved}`}
                      style={{ left: at(dr.mean) }}
                    />
                  </span>
                  <span className={e === "worse" ? styles.worse : styles.better}>
                    {e === "worse"
                      ? `Made it worse: without it, ${bp(-dr.mean)} cheaper`
                      : `Saved ${bp(dr.mean)} per changed order`}
                  </span>
                  <span>
                    95% CI {signedBp(dr.ci95[0])} to {signedBp(dr.ci95[1])} · {num(dr.n)} graded
                    {de
                      ? ` · forecast error ${de.mean >= 0 ? `${bp(de.mean)} lower` : `${bp(-de.mean)} higher`} with it`
                      : ""}
                  </span>
                </>
              ) : (
                <span>
                  {r.changed === 0
                    ? "Changed no chosen plan in this sample."
                    : "Changed plans have no graded outcome yet."}
                </span>
              )}
            </span>
          </div>
        );
      })}
      <div className={styles.lightRow} aria-hidden="true">
        <span />
        <span />
        <span />
        <span className={styles.lightAxis}>
          <span className={styles.fAxis}>
            {tv.map((t) => (
              <span key={t} style={{ left: at(t) }}>
                {t > 0 ? `+${t}` : t < 0 ? `−${-t}` : "0"}
              </span>
            ))}
          </span>
          <span className={styles.fDirs}>
            <span>← made it worse</span>
            <span>saved cost →</span>
          </span>
        </span>
      </div>
    </div>
  );
}
