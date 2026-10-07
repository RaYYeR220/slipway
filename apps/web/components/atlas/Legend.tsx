import ui from "../site/ui.module.css";
import styles from "./atlas.module.css";
import { METRICS, type Metric, metricT, RAMP_STOPS, rampGradient } from "./geometry";

export function MetricLegend({ metric }: { metric: Metric }) {
  const m = METRICS.find((x) => x.id === metric);
  return (
    <div className={styles.legendRow}>
      <div className={ui.ramp}>
        <span>{m?.long}, log scale</span>
        <span className={ui.rampBar} style={{ background: rampGradient(metric) }} />
        <span className={styles.rampStops}>
          {RAMP_STOPS[metric].map((s) => (
            <span key={s.v} style={{ left: `${metricT(s.v, metric) * 100}%` }}>
              {s.label}
            </span>
          ))}
        </span>
      </div>
      <div className={styles.hatchKey}>
        <svg viewBox="0 0 24 12" width="24" height="12" aria-hidden="true" focusable="false">
          <defs>
            <pattern
              id="lg-hatch"
              width="3"
              height="3"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="3" style={{ stroke: "var(--hatch)" }} strokeWidth="0.8" />
            </pattern>
          </defs>
          <rect
            width="24"
            height="12"
            rx="1"
            fill="url(#lg-hatch)"
            style={{ stroke: "var(--rule)" }}
            strokeWidth="0.5"
          />
        </svg>
        <span>not recorded yet</span>
      </div>
    </div>
  );
}
