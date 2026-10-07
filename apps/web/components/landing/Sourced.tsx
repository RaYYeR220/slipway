import type { LiquidityStats } from "@slipway/core";
import { Unavailable } from "../site/Code";
import type { AtlasDoc, Fetched } from "../site/data";
import { bp, num, nyTime, sessionLabel, usd } from "../site/fmt";
import ui from "../site/ui.module.css";
import styles from "./landing.module.css";

interface Slot {
  id: string;
  value: string;
  source: string;
  detail: string;
}

function pickSession(atlas: AtlasDoc, sym: string): string | null {
  const order = ["overnight", "regular", "pre_market", "after_hours", "weekend"];
  for (const s of order) if (atlas.atlas[`${sym}|rtoken|${s}`] && atlas.atlas[`${sym}|perp|${s}`]) return s;
  return null;
}

const span = (s: LiquidityStats) => `${num(s.n)} book snapshots, ${nyTime(s.from)} → ${nyTime(s.to)}`;

export function Sourced({ atlas }: { atlas: Fetched<AtlasDoc> }) {
  if (!atlas.ok) return <Unavailable what="The liquidity atlas" url={atlas.url} error={atlas.error} />;
  const sym = "NVDA";
  const session = pickSession(atlas.data, sym);
  const r = session ? atlas.data.atlas[`${sym}|rtoken|${session}`] : undefined;
  const p = session ? atlas.data.atlas[`${sym}|perp|${session}`] : undefined;
  if (!session || !r || !p)
    return (
      <Unavailable what={`The ${sym} atlas entry`} url={atlas.url} error="no session with both venues yet" />
    );

  const key = (v: string) => `${sym}|${v}|${session}`;
  const slots: Slot[] = [
    {
      id: "rtoken.spread",
      value: bp(r.spreadBps.p50, 2),
      source: `atlas ${key("rtoken")} spreadBps.p50`,
      detail: span(r),
    },
    {
      id: "rtoken.depth",
      value: usd(r.depthUsd.b25.p50),
      source: `atlas ${key("rtoken")} depthUsd.b25.p50`,
      detail: "median per-side notional within the band, full-depth REST snapshots",
    },
    {
      id: "band",
      value: "25 bp",
      source: "atlas definition: depth band b25",
      detail: "packages/core/src/atlas.ts",
    },
    {
      id: "perp.spread",
      value: bp(p.spreadBps.p50, 2),
      source: `atlas ${key("perp")} spreadBps.p50`,
      detail: span(p),
    },
    {
      id: "perp.depth",
      value: usd(p.depthUsd.b25.p50),
      source: `atlas ${key("perp")} depthUsd.b25.p50`,
      detail: "median per-side notional within the band",
    },
  ];
  const s = (id: string) => slots.findIndex((x) => x.id === id);
  const chip = (id: string) => {
    const i = s(id);
    const slot = slots[i];
    if (!slot) return null;
    return (
      <span className={styles.chip}>
        {slot.value}
        <sup>{i + 1}</sup>
      </span>
    );
  };
  const tok = (id: string) => <span className={styles.tok}>{`{{${id}}}`}</span>;
  const when = sessionLabel(session).toLowerCase();

  return (
    <div className={styles.sourced}>
      <div className={styles.layer}>
        <p className={styles.layerName}>What the model writes</p>
        <p className={styles.template}>
          In the {when} session the rNVDA book quoted {tok("rtoken.spread")} wide with {tok("rtoken.depth")} a
          side within {tok("band")} of mid; the NVDA perp quoted {tok("perp.spread")} with {tok("perp.depth")}
          .
        </p>
      </div>
      <div className={styles.fill} aria-hidden="true">
        <span>code fills every slot from its source</span>
      </div>
      <div className={styles.layer}>
        <p className={styles.layerName}>What you read</p>
        <div className={styles.readGrid}>
          <p className={styles.rendered}>
            In the {when} session the rNVDA book quoted {chip("rtoken.spread")} wide with{" "}
            {chip("rtoken.depth")} a side within {chip("band")} of mid; the NVDA perp quoted{" "}
            {chip("perp.spread")} with {chip("perp.depth")}.
          </p>
          <ol className={styles.sources}>
            {slots.map((x) => (
              <li key={x.id}>
                <code>{x.source}</code>
                <span>{x.detail}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className={ui.caption}>
        Live values from the recorded atlas, built from Bitget’s public order books.
        <span className={ui.source}>{atlas.url}</span>
      </p>
    </div>
  );
}
