import type { ReactNode } from "react";
import ui from "../site/ui.module.css";
import styles from "./landing.module.css";

// Lane geometry (viewBox 640 × 44): x = 14 is "now", x = 300 is the next regular open.
const NOW = 14;
const OPEN = 300;
const Y = 22;
const VB = "0 0 640 44";

function Dots({ xs, venue }: { xs: number[]; venue: "rtoken" | "perp" }) {
  const c = venue === "rtoken" ? "var(--venue-rtoken)" : "var(--venue-perp)";
  return (
    <>
      <line
        x1={xs[0]}
        x2={xs[xs.length - 1]}
        y1={Y}
        y2={Y}
        style={{ stroke: c }}
        strokeWidth="2"
        strokeLinecap="round"
      />
      {xs.map((x) => (
        <circle key={x} cx={x} cy={Y} r="4.5" style={{ fill: c, stroke: "var(--bg)" }} strokeWidth="2" />
      ))}
    </>
  );
}

function Anchor({ x }: { x: number }) {
  return (
    <g
      transform={`translate(${x} ${Y})`}
      style={{ stroke: "var(--hold)" }}
      fill="none"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <circle cx="0" cy="-8" r="2" />
      <path d="M0 -6 V7 M-6 2 Q-5 8 0 8 Q5 8 6 2 M-3 -3 H3" />
    </g>
  );
}

const LANES: { id: string; title: string; text: string; draw: ReactNode }[] = [
  {
    id: "rtoken",
    title: "rToken now",
    text: "Slice into the live R‹SYM›USDT book. Wins when the stock’s own book is deep enough for the size.",
    draw: <Dots xs={[NOW, 54, 94, 134, 174]} venue="rtoken" />,
  },
  {
    id: "perp",
    title: "Perp now",
    text: "Trade the USDT-M stock perp. Often the tightest quote at night, but thinner a few basis points out.",
    draw: <Dots xs={[NOW, 64, 114]} venue="perp" />,
  },
  {
    id: "wait",
    title: "Wait for the open",
    text: "Hold until the regular session, then slice into the deep book. Priced with the gap risk of waiting.",
    draw: (
      <>
        <Anchor x={NOW} />
        <line
          x1={NOW + 10}
          x2={OPEN - 4}
          y1={Y}
          y2={Y}
          style={{ stroke: "var(--faint)" }}
          strokeWidth="1"
          strokeDasharray="1 4"
          strokeLinecap="round"
        />
        <Dots xs={[OPEN + 16, 356, 396, 436, 476, 516]} venue="rtoken" />
      </>
    ),
  },
  {
    id: "rotate",
    title: "Perp now, rotate at the open",
    text: "Take exposure on the perp now, swap into the rToken once its book deepens. Priced with basis risk and funding.",
    draw: (
      <>
        <Dots xs={[NOW, 54]} venue="perp" />
        <line
          x1={54}
          x2={OPEN}
          y1={Y}
          y2={Y}
          style={{ stroke: "var(--venue-perp)" }}
          strokeWidth="1"
          opacity="0.6"
        />
        <path
          d={`M${OPEN} ${Y} C${OPEN + 6} ${Y - 12} ${OPEN + 14} ${Y - 12} ${OPEN + 20} ${Y}`}
          fill="none"
          style={{ stroke: "var(--muted)" }}
          strokeWidth="1.2"
        />
        <Dots xs={[OPEN + 20, 360, 400, 440]} venue="rtoken" />
      </>
    ),
  },
];

const CHECKS = [
  "DATA_STALE",
  "SOURCE_MISSING",
  "VENUE_CLOSED",
  "BOOK_EXHAUSTED",
  "COST_CAP",
  "PARTICIPATION",
  "EVENT_WINDOW",
  "PRICE_INTEGRITY",
  "PROFILE",
  "DEADLINE",
];

export function VerdictGlyph({ kind }: { kind: "allow" | "hold" | "refuse" }) {
  const c = `var(--${kind})`;
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true" focusable="false">
      {kind === "allow" && (
        <path d="M2 2 L7 7 L2 12 M9 2 L14 7 L9 12" fill="none" style={{ stroke: c }} strokeWidth="1.6" />
      )}
      {kind === "hold" && (
        <path
          d="M2 5 Q6 2 10 5 T18 5 M2 10 Q6 7 10 10 T18 10"
          fill="none"
          style={{ stroke: c }}
          strokeWidth="1.6"
        />
      )}
      {kind === "refuse" && (
        <path
          d="M1 10 L4 4 L7 10 L10 4 L13 10 L16 4 L19 10"
          fill="none"
          style={{ stroke: c }}
          strokeWidth="1.6"
        />
      )}
    </svg>
  );
}

export function Decide() {
  return (
    <div className={styles.decide}>
      <div className={styles.lanes}>
        <div className={styles.laneAxis} aria-hidden="true">
          <span />
          <div className={styles.axisMarks}>
            <span className={styles.nowMark} style={{ left: `${(NOW / 640) * 100}%` }}>
              now
            </span>
            <span style={{ left: `${(OPEN / 640) * 100}%` }}>regular open, 09:30 ET</span>
          </div>
        </div>
        <ul className={styles.laneList}>
          {LANES.map((l) => (
            <li key={l.id} className={styles.lane}>
              <div>
                <h3 className={styles.laneTitle}>{l.title}</h3>
                <p className={styles.laneText}>{l.text}</p>
              </div>
              <svg viewBox={VB} preserveAspectRatio="xMinYMid meet" aria-hidden="true" focusable="false">
                <line x1={OPEN} x2={OPEN} y1="0" y2="44" style={{ stroke: "var(--grid)" }} strokeWidth="1" />
                {l.draw}
              </svg>
            </li>
          ))}
        </ul>
        <ul className={ui.legend} aria-label="Legend">
          <li>
            <i
              className={ui.ringKey}
              style={{ color: "var(--venue-rtoken)", background: "var(--venue-rtoken)" }}
            />
            rToken slice
          </li>
          <li>
            <i
              className={ui.ringKey}
              style={{ color: "var(--venue-perp)", background: "var(--venue-perp)" }}
            />
            perp slice
          </li>
          <li>
            <svg viewBox="-8 -12 16 22" width="12" height="16" aria-hidden="true" focusable="false">
              <g style={{ stroke: "var(--hold)" }} fill="none" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="0" cy="-8" r="2" />
                <path d="M0 -6 V7 M-6 2 Q-5 8 0 8 Q5 8 6 2" />
              </g>
            </svg>
            waiting, no order working
          </li>
        </ul>
      </div>

      <div className={styles.pipeline}>
        <div className={styles.step}>
          <h3 className={styles.stepTitle}>The best plan</h3>
          <p className={styles.stepText}>
            Every path is scored as its expected cost plus a charge for its uncertainty, sized by how urgent
            you said you are. The lowest score wins, and the Bitget-app TWAP is priced beside it so you see
            what the choice is worth.
          </p>
        </div>

        <div className={styles.flowArrow} aria-hidden="true" />

        <div className={styles.gate}>
          <h3 className={styles.stepTitle}>The gate</h3>
          <p className={styles.stepText}>
            Each path is priced, then the best plan meets checks written in code. One refuse blocks it; one
            hold parks it with the fix.
          </p>
          <ul className={styles.checks}>
            {CHECKS.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <ul className={styles.verdicts}>
            <li>
              <VerdictGlyph kind="allow" /> Allow
            </li>
            <li>
              <VerdictGlyph kind="hold" /> Hold
            </li>
            <li>
              <VerdictGlyph kind="refuse" /> Refuse
            </li>
          </ul>
        </div>

        <div className={styles.flowArrow} aria-hidden="true" />

        <div className={styles.ticket}>
          <h3 className={styles.stepTitle}>One ticket per slice</h3>
          <p className={styles.stepText}>
            An allowed plan is hashed and signed. Only a fresh, signed, allowed plan becomes tickets: the
            exact request Bitget’s agent SDK would send, as a dry run.
          </p>
          <pre className={styles.ticketCode}>
            <code>
              {
                "bgc --read-only order --action place\n  --category SPOT --symbol RNVDAUSDT\n  --side buy --orderType limit\n  --price ‹walk cap› --qty ‹slice›\n  --timeInForce ioc --dry-run"
              }
            </code>
          </pre>
          <p className={styles.stepNote}>Nothing is sent to the exchange.</p>
        </div>
      </div>
    </div>
  );
}
