"use client";
// Dry-run tickets, one per slice, as drifter tags: the deploy time, the venue, the order the Bitget agent SDK
// would send and the bgc command that reproduces it with --dry-run. Nothing here is ever sent.
import { useState } from "react";
import { nyClock, nyDayTime, pluralize, price, qty, sessionLabel, venueName } from "@/lib/desk/format";
import type { ApiFailure, Held, OrderTicket, PlanData, TicketsData } from "@/lib/desk/types";
import c from "./canvas.module.css";
import { Empty, Failure, SectionHead, Working } from "./parts";

interface Props {
  plan: Held<PlanData> | null;
  tickets: Held<TicketsData> | null;
  busy: string | undefined;
  error: ApiFailure | undefined;
}

const KIND: Record<OrderTicket["kind"], string> = {
  ioc_limit: "IOC limit",
  post_only: "post-only limit",
  gtc_limit: "GTC limit",
  market: "market",
  cancel_remaining_then_market: "cancel rest, then market",
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={c.copyBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone("copied");
        } catch {
          setDone("failed");
        }
        window.setTimeout(() => setDone("idle"), 1600);
      }}
      aria-label={label}
    >
      {done === "copied" ? "Copied" : done === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

function Ticket({ t, symbol }: { t: OrderTicket; symbol: string }) {
  return (
    <li className={c.ticket} data-side={t.side}>
      <div className={c.ticketTag}>
        <span className={c.drifterDot} data-side={t.side} aria-hidden="true" />
        <span className={c.tagId}>{t.clientOid}</span>
      </div>
      <div className={c.ticketMain}>
        <p className={c.ticketLine}>
          <span className={t.side === "buy" ? c.buy : c.sell}>{t.side === "buy" ? "Buy" : "Sell"}</span>{" "}
          <span className={c.mono}>{qty(t.qty)}</span> {venueName(t.venue, symbol)}{" "}
          <span className={c.dim}>({t.symbol})</span>
        </p>
        <p className={c.ticketMeta}>
          {nyDayTime(t.t)}:{nyClock(t.t).slice(6)} NY, {sessionLabel(t.session)} · {KIND[t.kind]}
          {t.limitPx !== null ? ` at ${price(t.limitPx)}` : ""}
          {t.conditional ? " · only the unfilled remainder" : ""}
        </p>
        <div className={c.cmd}>
          <code className={c.cmdText}>{t.bgc}</code>
          <CopyButton text={t.bgc} label={`Copy the bgc command for ticket ${t.index + 1}`} />
        </div>
        {t.cancel ? (
          <div className={c.cmd}>
            <code className={c.cmdText}>{t.cancel.bgc}</code>
            <CopyButton text={t.cancel.bgc} label={`Copy the cancel command for ticket ${t.index + 1}`} />
          </div>
        ) : null}
        <details className={c.payload}>
          <summary>
            Request the SDK would send: {t.request.method} {t.request.path}
          </summary>
          <pre className={c.pre}>{JSON.stringify(t.request.body, null, 2)}</pre>
        </details>
        {t.notes.length ? <p className={c.ticketNotes}>{t.notes.join(". ")}.</p> : null}
        {t.violations.length ? <p className={c.violation}>{t.violations.join("; ")}</p> : null}
      </div>
    </li>
  );
}

export function TicketsSection({ plan, tickets, busy, error }: Props) {
  const d = tickets?.data ?? null;
  const symbol = plan?.data.intent.symbol ?? "";
  return (
    <section className={c.section} aria-labelledby="h-tickets" id="desk-tickets">
      <SectionHead
        id="h-tickets"
        title="Tickets"
        lede="One ticket per slice, built by the Bitget agent SDK in dry-run mode. Dry run: nothing is sent to the exchange."
        aside={
          d?.ok ? (
            <span className={c.status}>
              {pluralize(d.tickets.length, "ticket")}, SDK {d.tickets[0]?.sdkVersion}, max slippage{" "}
              {d.maxSlippageBps} bp
            </span>
          ) : null
        }
      />
      {busy ? (
        <Working
          text="Re-verifying the signature and the plan's age, then building one SDK request per slice…"
          rows={2}
        />
      ) : error ? (
        <Failure error={error} what="Tickets failed" />
      ) : !d ? (
        <Empty>
          <p>
            {plan
              ? plan.data.verdict === "allow"
                ? "The plan is allowed. Issue dry-run tickets from the gate within its minute."
                : "No tickets: the gate did not allow this plan."
              : "Tickets appear after a plan passes the gate and you ask for them."}
          </p>
        </Empty>
      ) : d.ok ? (
        <>
          <p className={c.dryRun}>
            <span className={c.dryMark} aria-hidden="true" />
            <span>
              Dry run for plan <span className={c.mono}>{d.planId}</span>. Nothing is sent.
            </span>
          </p>
          <ol className={c.tickets}>
            {d.tickets.map((t) => (
              <Ticket key={t.clientOid} t={t} symbol={symbol || t.symbol.replace(/^R|USDT$/g, "")} />
            ))}
          </ol>
          {d.notes.length ? <p className={c.note}>{d.notes.join(". ")}.</p> : null}
        </>
      ) : (
        <div className={c.gate} data-verdict="refuse">
          <p className={c.verdictWord}>Tickets refused</p>
          <p className={c.blockerDetail}>{d.reason}</p>
          {d.fixes.length ? (
            <ol className={c.checks}>
              {d.fixes.map((f) => (
                <li key={f.code} className={c.check} data-status={f.status}>
                  <span className={c.checkMark} data-status={f.status}>
                    {f.status}
                  </span>
                  <div className={c.checkBody}>
                    <p className={c.checkName}>
                      <code className={c.code}>{f.code}</code>
                    </p>
                    <p className={c.checkDetail}>{f.detail}</p>
                    {f.fix ? <p className={c.checkFix}>Fix: {f.fix}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}
    </section>
  );
}
