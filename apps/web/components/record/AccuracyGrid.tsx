import type { AccuracyRow } from "../site/data";
import { bp, num, pct, sessionLabel, signedBp, venueLabel } from "../site/fmt";
import styles from "./record.module.css";

const HORIZONS = ["0-60s", "1-15m", "15m-6h", ">6h"];
const HORIZON_LABEL: Record<string, string> = {
  "0-60s": "Within a minute",
  "1-15m": "1 to 15 minutes",
  "15m-6h": "15 minutes to 6 hours",
  ">6h": "Over 6 hours",
};
const SESSIONS = ["pre_market", "regular", "after_hours", "overnight", "weekend"];

/**
 * Small multiples: one cell per venue × session × horizon. MAE as a bar on one shared scale, bias as a signed
 * figure, p10–p90 coverage as a meter against the 80% a calibrated band should hold.
 */
export function AccuracyGrid({ rows }: { rows: AccuracyRow[] }) {
  const orders = rows.filter((r) => r.scope === "order");
  const slices = rows.filter((r) => r.scope === "slice");
  const horizons = HORIZONS.filter((h) => rows.some((r) => r.horizon === h));
  const keys = [...new Set(orders.map((r) => `${r.venue}|${r.session}`))].sort((a, b) => {
    const [va = "", sa = ""] = a.split("|");
    const [vb = "", sb = ""] = b.split("|");
    return va.localeCompare(vb) || SESSIONS.indexOf(sa) - SESSIONS.indexOf(sb);
  });
  const maxMae = Math.max(1, ...orders.map((r) => r.maeBps));
  const find = (list: AccuracyRow[], k: string, h: string) =>
    list.find((r) => `${r.venue}|${r.session}` === k && r.horizon === h);

  if (!keys.length) return <p className={styles.empty}>No order has been graded yet.</p>;
  return (
    <>
      <ul className={styles.accKey}>
        <li>
          <span className={styles.accBar} aria-hidden="true">
            <span style={{ width: "60%" }} />
          </span>
          mean absolute error, one scale for every cell
        </li>
        <li>
          <span className={styles.meter} aria-hidden="true">
            <span style={{ width: "70%" }} />
            <i style={{ left: "80%" }} />
          </span>
          share of orders inside the p10–p90 band; the tick marks 80%
        </li>
      </ul>
      <div
        className={styles.accGrid}
        style={{ gridTemplateColumns: `minmax(120px, 0.7fr) repeat(${horizons.length}, minmax(0, 1fr))` }}
      >
        <div className={styles.accCorner} />
        {horizons.map((h) => (
          <div key={h} className={styles.accHead}>
            {HORIZON_LABEL[h] ?? h}
          </div>
        ))}
        {keys.map((k) => {
          const [v = "", s = ""] = k.split("|");
          return [
            <div key={`${k}-l`} className={styles.accRowHead}>
              <span>{venueLabel(v)}</span>
              <span className={styles.accSession}>{sessionLabel(s)}</span>
            </div>,
            ...horizons.map((h) => {
              const o = find(orders, k, h);
              const sl = find(slices, k, h);
              if (!o)
                return (
                  <div key={`${k}-${h}`} className={`${styles.accCell} ${styles.accNone}`}>
                    <span className={styles.accCellH}>{HORIZON_LABEL[h] ?? h}</span>
                    not graded yet
                  </div>
                );
              const cov = o.coverage;
              return (
                <div key={`${k}-${h}`} className={`${styles.accCell} ${o.n < 10 ? styles.accThin : ""}`}>
                  <span className={styles.accCellH}>{HORIZON_LABEL[h] ?? h}</span>
                  <span className={styles.accMae}>{bp(o.maeBps, 2)}</span>
                  <span className={styles.accBar} aria-hidden="true">
                    <span style={{ width: `${(o.maeBps / maxMae) * 100}%` }} />
                  </span>
                  <span className={styles.accLine}>
                    bias {signedBp(o.biasBps, 2)} · n {num(o.n)}
                    {o.n < 10 ? " · too few to read" : ""}
                  </span>
                  {cov && (
                    <span className={styles.accCov}>
                      <span className={styles.meter} aria-hidden="true">
                        <span style={{ width: `${cov.rate * 100}%` }} />
                        <i style={{ left: "80%" }} />
                      </span>
                      <span>
                        {pct(cov.rate)} inside p10–p90 ({num(cov.inside)}/{num(cov.n)})
                      </span>
                    </span>
                  )}
                  {sl && (
                    <span className={styles.accSlice}>
                      per slice {bp(sl.maeBps, 2)}, n {num(sl.n)}
                    </span>
                  )}
                </div>
              );
            }),
          ];
        })}
      </div>
    </>
  );
}
