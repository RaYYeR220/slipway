"use client";
// Venue plates: the best plan of every strategy family on one shared cost axis, each with its 80% band, an
// ensemble drawn from it and what its expected cost is made of; beside them, the frontier of every candidate.
import { useMemo } from "react";
import {
  bps,
  FAMILY_ORDER,
  familyName,
  isBaselineId,
  num,
  nyDayTime,
  pluralize,
  sessionLabel,
  usd,
  venueName,
} from "@/lib/desk/format";
import type { ApiFailure, Held, OptionsData, PlanData, QuoteView } from "@/lib/desk/types";
import { CostInterval } from "../../charts/CostInterval";
import { Frontier } from "../../charts/Frontier";
import { useWidth } from "../../charts/hooks";
import { COMPONENT_COLOR, familyColor } from "../../charts/ramps";
import { niceTicks } from "../../charts/scale";
import c from "./canvas.module.css";
import { Empty, Failure, SectionHead, Working } from "./parts";

interface Props {
  symbol: string;
  options: Held<OptionsData> | null;
  plan: Held<PlanData> | null;
  busy: string | undefined;
  planBusy: string | undefined;
  error: ApiFailure | undefined;
  loadingText: string;
  light: boolean;
  onSign: (strategyId: string) => void;
}

function domainOf(qs: QuoteView[]): [number, number] {
  const core: number[] = [0];
  const widths = qs.map((q) => q.p90Bps - q.p10Bps).sort((a, b) => a - b);
  const med = widths[Math.floor(widths.length / 2)] ?? 0;
  for (const q of qs) {
    core.push(q.expectedBps);
    // a band far wider than the rest (a session-gap gamble) is clipped, not allowed to flatten everyone else
    if (q.p90Bps - q.p10Bps <= Math.max(6, med * 4)) core.push(q.p10Bps, q.p90Bps);
  }
  let lo = Math.min(...core);
  let hi = Math.max(...core);
  const pad = Math.max(1, (hi - lo) * 0.08);
  lo -= lo < 0 ? pad : 0;
  hi += pad;
  return [lo, hi];
}

export function OptionsSection({
  symbol,
  options,
  plan,
  busy,
  planBusy,
  error,
  loadingText,
  light,
  onSign,
}: Props) {
  const o = options?.data ?? null;
  const chosenId = plan?.data.strategy.id ?? o?.best?.id ?? null;

  const plates = useMemo(() => {
    if (!o) return [];
    const out: { q: QuoteView; kind: string; title: string }[] = [];
    for (const k of FAMILY_ORDER) {
      const q = o.families[k];
      if (q) out.push({ q, kind: k, title: familyName(k) });
    }
    if (o.baseline) out.push({ q: o.baseline, kind: o.baseline.kind, title: "TWAP baseline" });
    const p = plan?.data.strategy;
    if (p && !out.some((x) => x.q.id === p.id))
      out.unshift({ q: p, kind: p.kind, title: `Your plan: ${familyName(p.kind, p.id)}` });
    return out;
  }, [o, plan]);

  const [lo, hi] = useMemo(() => domainOf(plates.map((x) => x.q)), [plates]);
  const [axisRef, axisW] = useWidth<HTMLDivElement>();
  const ticks = niceTicks(lo, hi, 5);

  const counts = o
    ? `${pluralize(o.candidates, "strategy", "strategies")} priced, ${o.frontier.filter((f) => f.feasible).length} feasible${o.skipped.count ? `, ${o.skipped.count} skipped` : ""}`
    : null;

  return (
    <section className={c.section} aria-labelledby="h-options" id="desk-options">
      <SectionHead
        id="h-options"
        title="Venue options"
        lede="The best plan in each strategy family on one cost axis, in basis points of the arrival mid. The line is the 80% band (p10 to p90), the dots an ensemble drawn from it, the strip under it what the expected cost is made of."
        aside={counts ? <span className={c.status}>{counts}</span> : null}
      />
      {busy && !o ? (
        <Working text={loadingText} rows={4} />
      ) : error && !o ? (
        <Failure error={error} what="Could not price this order" />
      ) : !o ? (
        <Empty>
          <p>
            Nothing priced yet. Write the order in the line above, or ask in the conversation; every option
            for {symbol} lands here.
          </p>
        </Empty>
      ) : (
        <div className={c.optionsGrid}>
          <div className={c.platesCol}>
            {busy ? <p className={c.inlineBusy}>Re-pricing on fresh books…</p> : null}
            <div className={c.axisHead}>
              <span className={c.axisLabel}>Family</span>
              <div ref={axisRef} className={c.axisTicks} aria-hidden="true">
                {axisW > 0
                  ? ticks.map((t) => (
                      <span key={t} style={{ left: 8 + ((t - lo) / (hi - lo)) * (axisW - 16) }}>
                        {num(t, 0)}
                      </span>
                    ))
                  : null}
              </div>
              <span className={c.axisLabelR}>Expected</span>
            </div>
            <ol className={c.plates}>
              {plates.map(({ q, kind, title }) => (
                <Plate
                  key={q.id}
                  q={q}
                  kind={kind}
                  title={title}
                  symbol={o.intent.symbol}
                  lo={lo}
                  hi={hi}
                  width={axisW}
                  light={light}
                  chosen={q.id === chosenId}
                  best={q.id === o.best?.id}
                  planned={q.id === plan?.data.strategy.id}
                  signing={planBusy === q.id}
                  disabled={!!planBusy}
                  onSign={() => onSign(q.id)}
                />
              ))}
            </ol>
            <div className={c.compKey}>
              {(Object.keys(COMPONENT_COLOR) as (keyof typeof COMPONENT_COLOR)[]).map((k) => (
                <span key={k} className={c.keyItem}>
                  <span className={c.keySwatch} style={{ background: COMPONENT_COLOR[k] }} />
                  {k}
                </span>
              ))}
              <span className={c.keyNote}>Risk (sd) is the band, not the strip.</span>
            </div>
            {o.skipped.reasons.length ? (
              <p className={c.note}>
                Skipped:{" "}
                {o.skipped.reasons
                  .slice(0, 3)
                  .map((r) => `${r.reason} (${r.count})`)
                  .join("; ")}
                .
              </p>
            ) : null}
            {o.assumptions.length ? <p className={c.note}>Assumes: {o.assumptions.join("; ")}.</p> : null}
          </div>
          <div className={c.frontierCol} id="desk-frontier">
            <div>
              <h3 className={c.h3}>Cost against risk, all {o.candidates} candidates</h3>
              <Frontier
                points={o.frontier}
                lambda={o.lambda}
                chosenId={chosenId}
                baselineId={o.baseline?.id ?? null}
                light={light}
              />
            </div>
            <div className={c.frontierAside}>
              <p>
                Each dot is one priced schedule: a venue, a session and a way of slicing it. The planner picks
                the lowest score, expected cost plus λ times its spread. At {o.profile.urgency} urgency λ is{" "}
                {num(o.lambda, 2)}, so{" "}
                {o.lambda < 0.5
                  ? "a cheaper but less certain plan can win."
                  : o.lambda > 2
                    ? "certainty is worth a lot: a slightly dearer but tighter plan wins."
                    : "a basis point of expected cost and a basis point of spread weigh the same."}
              </p>
              {o.savingVsBaseline && o.baseline ? (
                <p>
                  Against the Bitget-style TWAP baseline ({o.baseline.label}), the chosen plan is{" "}
                  {o.savingVsBaseline.bps >= 0
                    ? `${bps(o.savingVsBaseline.bps)} cheaper in expectation, ${usd(o.savingVsBaseline.usd, 2)} on this order.`
                    : `${bps(-o.savingVsBaseline.bps)} dearer in expectation but with a tighter band.`}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Plate({
  q,
  kind,
  title,
  symbol,
  lo,
  hi,
  width,
  light,
  chosen,
  best,
  planned,
  signing,
  disabled,
  onSign,
}: {
  q: QuoteView;
  kind: string;
  title: string;
  symbol: string;
  lo: number;
  hi: number;
  width: number;
  light: boolean;
  chosen: boolean;
  best: boolean;
  planned: boolean;
  signing: boolean;
  disabled: boolean;
  onSign: () => void;
}) {
  const baseline = isBaselineId(q.id);
  const venues = q.venues.map((v) => venueName(v, symbol)).join(" then ");
  const sessions = q.sessions.map(sessionLabel).join(", ");
  return (
    <li className={chosen ? `${c.plate} ${c.plateChosen}` : c.plate}>
      <div className={c.plateHead}>
        <h3 className={c.plateName}>
          <span className={c.dot} style={{ background: familyColor(kind, light) }} aria-hidden="true" />
          {title}
          {best ? <span className={c.tag}>lowest score</span> : null}
          {planned ? <span className={c.tag}>signed</span> : null}
        </h3>
        <p className={c.plateLabel}>{q.label}</p>
        <p className={c.plateMeta}>
          {pluralize(q.sliceCount, "slice")} on {venues}, {sessions}, from {nyDayTime(q.startsAt)}
          {q.endsAt > q.startsAt + 60_000 ? ` to ${nyDayTime(q.endsAt)}` : ""}
        </p>
        {!q.feasible || q.violations.length ? (
          <p className={c.violation}>
            Breaks {q.violations.join(", ") || "a constraint"}: shown, never chosen.
          </p>
        ) : null}
      </div>
      <div className={c.plateChart}>
        {width > 0 ? (
          <CostInterval q={q} lo={lo} hi={hi} width={width} light={light} chosen={chosen} colorKind={kind} />
        ) : null}
      </div>
      <div className={c.plateNums}>
        <span className={c.bigBps}>
          {num(q.expectedBps)}
          <span className={c.unit}> bp</span>
        </span>
        <span className={c.plateUsd}>{usd(q.expectedCostUsd, 2)}</span>
        <span className={c.plateBand}>
          {num(q.p10Bps)} to {num(q.p90Bps)}
        </span>
        <button
          type="button"
          className={planned ? c.ghostBtn : c.signBtn}
          onClick={onSign}
          disabled={disabled || (!q.feasible && !baseline)}
          aria-label={`Gate and sign: ${q.label}`}
        >
          {signing ? "Signing…" : planned ? "Re-sign" : "Gate and sign"}
        </button>
      </div>
      <p className={c.sr}>
        {title}: expected {bps(q.expectedBps)}, band {bps(q.p10Bps)} to {bps(q.p90Bps)}, cost{" "}
        {usd(q.expectedCostUsd, 2)}.
      </p>
    </li>
  );
}
