"use client";
// The plan canvas: the order, the live market, the answer, then the evidence behind it — tide, venue options,
// gate, tickets and the ledger of sources. Every figure here is drawn from an API payload.
import {
  age,
  bps,
  familyName,
  num,
  nyClock,
  nyDayTime,
  pluralize,
  price,
  qty,
  sessionLabel,
  signed,
  usd,
  usdCompact,
  venueName,
} from "@/lib/desk/format";
import { scrollToSection } from "@/lib/desk/scroll";
import type { DeskState, IntentRequest, Loadable, MarketData, Profile, Venue } from "@/lib/desk/types";
import { useNow } from "../../charts/hooks";
import c from "./canvas.module.css";
import { EvidenceLedger } from "./EvidenceLedger";
import { GateSection } from "./GateSection";
import { OptionsSection } from "./OptionsSection";
import { OrderLine } from "./OrderLine";
import { Failure, Working } from "./parts";
import { TicketsSection } from "./TicketsSection";
import { TideSection } from "./TideSection";

interface Props {
  state: DeskState;
  busy: Partial<Record<Loadable, string>>;
  profile: Profile;
  light: boolean;
  reduced: boolean;
  onPrice: (i: IntentRequest) => void;
  onSign: (strategyId: string, intent: IntentRequest | null) => void;
  onIssue: () => void;
  onOpenProfile: () => void;
}

function loadingText(symbol: string, market: MarketData | null): string {
  const r = market?.venues.rtoken?.book?.levels;
  const p = market?.venues.perp?.book?.levels;
  if (r)
    return `Walking ${r.bids + r.asks} levels of the r${symbol} book${p ? ` and ${p.bids + p.asks} of the perp` : ""}, then pricing every venue, session and slicing against them…`;
  return `Reading the live r${symbol} and perp books, then pricing every venue, session and slicing…`;
}

export function PlanCanvas({
  state,
  busy,
  profile,
  light,
  reduced,
  onPrice,
  onSign,
  onIssue,
  onOpenProfile,
}: Props) {
  const { options, plan, market } = state;
  const intentKey = options ? `${options.at}` : "none";
  const symbol = state.symbol;
  const lt = loadingText(symbol, market?.data ?? null);

  return (
    <main id="main" className={c.canvas} tabIndex={-1}>
      <div className={c.inner}>
        <OrderLine
          key={intentKey}
          initial={options?.intent ?? null}
          symbol={symbol}
          profile={profile}
          busy={!!busy.options}
          onSubmit={onPrice}
        />
        <MarketStrip
          symbol={symbol}
          market={market?.data ?? null}
          at={market?.at ?? 0}
          error={state.errors.market}
        />
        <Answer state={state} busy={busy} loading={lt} onSign={onSign} />
        <TideSection
          symbol={symbol}
          tide={state.tide}
          options={options}
          plan={plan}
          busy={!!busy.tide}
          error={state.errors.tide}
          light={light}
          reduced={reduced}
        />
        <OptionsSection
          symbol={symbol}
          options={options}
          plan={plan}
          busy={busy.options}
          planBusy={busy.plan}
          error={state.errors.options}
          loadingText={lt}
          light={light}
          onSign={(id) => onSign(id, options?.intent ?? null)}
        />
        <GateSection
          options={options}
          plan={plan}
          planBusy={busy.plan}
          ticketsBusy={busy.tickets}
          issued={!!(state.tickets?.data.ok && plan && state.tickets.data.planId === plan.data.planId)}
          error={state.errors.plan}
          profile={profile}
          onResign={() => plan && onSign(plan.data.strategy.id, plan.intent ?? null)}
          onIssue={onIssue}
          onSignBest={() => options?.data.best && onSign(options.data.best.id, options.intent ?? null)}
          onOpenProfile={onOpenProfile}
        />
        <TicketsSection
          plan={plan}
          tickets={state.tickets}
          busy={busy.tickets}
          error={state.errors.tickets}
        />
        <EvidenceLedger sources={state.sources} market={market} research={state.research} />
      </div>
    </main>
  );
}

function VenueLive({ v, symbol, m }: { v: Venue; symbol: string; m: MarketData }) {
  const x = m.venues[v];
  if (!x) return null;
  const b = x.book;
  return (
    <div className={c.mkVenue}>
      <span className={c.mkName}>{venueName(v, symbol)}</span>
      {b ? (
        <>
          <span className={c.mkPx}>{price(b.mid)}</span>
          <span className={c.mkFact}>
            spread <b>{num(b.spreadBps, 2)} bp</b>
          </span>
          <span className={c.mkFact}>
            ±25 bp <b>{usdCompact(b.depthUsd.b25.bid)}</b> bid / <b>{usdCompact(b.depthUsd.b25.ask)}</b> ask
          </span>
          <span className={c.mkFact}>{b.levels.bids + b.levels.asks} levels</span>
        </>
      ) : (
        <span className={c.mkFact}>no book</span>
      )}
      <span className={x.tradableNow ? c.mkOpen : c.mkClosed}>
        {x.tradableNow ? "trading" : "closed now"}
      </span>
    </div>
  );
}

function MarketStrip({
  symbol,
  market,
  at,
  error,
}: {
  symbol: string;
  market: MarketData | null;
  at: number;
  error: DeskState["errors"]["market"];
}) {
  const now = useNow(1000);
  if (!market) {
    if (error) return <Failure error={error} what={`The ${symbol} market is unavailable`} />;
    return (
      <div className={c.market} aria-busy="true">
        <p className={c.mkWait}>
          Reading the live r{symbol} and {symbol} perp books…
        </p>
      </div>
    );
  }
  const next = market.nextSessions.find((n) => n.start > market.now + 1000);
  const rClosed = market.venues.rtoken && !market.venues.rtoken.tradableNow;
  return (
    <section className={c.market} aria-label={`Live market for ${symbol}`}>
      <VenueLive v="rtoken" symbol={symbol} m={market} />
      <VenueLive v="perp" symbol={symbol} m={market} />
      <p className={c.mkSession}>
        New York is in <b>{sessionLabel(market.session.session)}</b>
        {next ? `; ${sessionLabel(next.session)} starts ${nyDayTime(next.start)}` : ""}.
        {market.basisBps !== null ? ` rToken/perp basis ${signed(market.basisBps)} bp.` : ""}
        {market.funding
          ? ` Funding ${signed(market.funding.rate * 100, 4)}% per ${market.funding.intervalHours} h.`
          : ""}{" "}
        <span className={c.mkAge}>Books read {age(now - at)} ago, refreshed every 20 s.</span>
      </p>
      {rClosed ? (
        <p className={c.closedNote}>
          r{symbol} is not trading now ({sessionLabel(market.session.session)}).
          {next ? ` It reopens with ${sessionLabel(next.session)} at ${nyDayTime(next.start)} NY.` : ""} Plans
          that need it now will be held or refused; waiting for the session is priced as its own option.
        </p>
      ) : null}
    </section>
  );
}

function Answer({
  state,
  busy,
  loading,
  onSign,
}: {
  state: DeskState;
  busy: Partial<Record<Loadable, string>>;
  loading: string;
  onSign: (strategyId: string, intent: IntentRequest | null) => void;
}) {
  const o = state.options?.data ?? null;
  if (busy.options && !o) {
    return (
      <div className={c.answer}>
        <Working text={loading} rows={2} />
      </div>
    );
  }
  if (!o) {
    if (state.errors.options)
      return (
        <div className={c.answer}>
          <Failure error={state.errors.options} what="Could not price this order" />
        </div>
      );
    return (
      <div className={c.answer}>
        <p className={c.answerLead}>
          Price an order to see every venue, session and slicing for {state.symbol}.
        </p>
        <p className={c.answerFacts}>
          Write it in the line above or ask in the conversation. Pricing reads the live Bitget books; nothing
          is sent.
        </p>
      </div>
    );
  }
  const i = o.intent;
  const size = i.notionalUsd !== undefined ? usd(i.notionalUsd) : `${qty(o.qty)} shares`;
  const best = o.best;
  const plan = state.plan?.data ?? null;
  const fromChat = state.options?.origin === "chat";
  return (
    <div className={c.answer} aria-live="polite">
      {best ? (
        <>
          <p className={c.answerLead}>
            {i.side === "buy" ? "Buy" : "Sell"} {size} of {i.symbol}: {best.label}.
          </p>
          <p className={c.answerFacts}>
            Expected <b>{bps(best.expectedBps)}</b> ({usd(best.expectedCostUsd, 2)}), 80% band{" "}
            {bps(best.p10Bps)} to {bps(best.p90Bps)}.
            {o.baseline && o.savingVsBaseline
              ? o.savingVsBaseline.bps >= 0.05
                ? ` ${bps(o.savingVsBaseline.bps)} (${usd(o.savingVsBaseline.usd, 2)}) cheaper than the Bitget-style TWAP baseline at ${bps(o.baseline.expectedBps)}.`
                : o.savingVsBaseline.bps <= -0.05
                  ? ` The TWAP baseline expects ${bps(o.baseline.expectedBps)}, ${bps(-o.savingVsBaseline.bps)} less, but with a wider band (${bps(o.baseline.p10Bps)} to ${bps(o.baseline.p90Bps)}), so it scores worse at your urgency.`
                  : ` Level with the TWAP baseline at ${bps(o.baseline.expectedBps)}.`
              : ""}
            {o.gate ? (
              <>
                {" "}
                Gate preview:{" "}
                <span className={c.verdictInline} data-verdict={o.gate.verdict}>
                  {o.gate.verdict.toUpperCase()}
                </span>
                .
              </>
            ) : null}
          </p>
          {o.gate && o.gate.verdict !== "allow"
            ? (() => {
                const b =
                  o.gate.checks.find((k) => k.status === o.gate?.verdict) ??
                  o.gate.checks.find((k) => k.status !== "pass");
                return b ? (
                  <p className={c.answerBlock} data-verdict={o.gate.verdict}>
                    <span className={c.mono}>{b.code}</span> {b.detail}.{b.fix ? ` Fix: ${b.fix}.` : ""}
                  </p>
                ) : null;
              })()
            : null}
          <p className={c.answerMeta}>
            {pluralize(o.candidates, "strategy", "strategies")} priced at {nyClock(o.now)} NY
            {fromChat ? " for the conversation" : ""}, λ {num(o.lambda, 2)} ({o.profile.urgency}), cost cap{" "}
            {bps(o.profile.costCapBps)}
            {i.deadlineNy ? `, deadline read as ${i.deadlineReading ?? "given"} (${i.deadlineNy})` : ""}
            {i.venues ? `, venues ${i.venues.map((v) => venueName(v, i.symbol)).join(" and ")}` : ""}.
          </p>
          {!plan ? (
            <div className={c.answerActions}>
              <button
                type="button"
                className={c.primary}
                onClick={() => onSign(best.id, state.options?.intent ?? null)}
                disabled={!!busy.plan}
              >
                {busy.plan ? "Signing…" : `Gate and sign: ${familyName(best.kind, best.id).toLowerCase()}`}
              </button>
              <button type="button" className={c.textLink} onClick={() => scrollToSection("desk-options")}>
                Compare all options
              </button>
            </div>
          ) : (
            <p className={c.answerPlan}>
              Signed plan <span className={c.mono}>{plan.planId}</span>: {plan.strategy.label}, gate{" "}
              <span className={c.verdictInline} data-verdict={plan.verdict}>
                {plan.verdict.toUpperCase()}
              </span>
              .{" "}
              <button type="button" className={c.textLink} onClick={() => scrollToSection("desk-gate")}>
                See the gate
              </button>
            </p>
          )}
        </>
      ) : (
        <>
          <p className={c.answerLead}>No strategy fits this order right now.</p>
          <p className={c.answerFacts}>
            {o.skipped.reasons.length
              ? `Skipped: ${o.skipped.reasons.map((r) => `${r.reason} (${r.count})`).join("; ")}.`
              : "Every candidate broke a constraint."}{" "}
            The frontier below still shows what each would cost.
          </p>
        </>
      )}
    </div>
  );
}
