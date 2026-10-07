"use client";
// The gate: every check the plan had to pass, in code, before it could be signed and ticketed. REFUSE is drawn as
// the most legible state on the canvas: the blocking check, what it found and how to fix it, first.
import { age, bps, familyName, nyClock, nyDayTime } from "@/lib/desk/format";
import { scrollToSection } from "@/lib/desk/scroll";
import type { ApiFailure, CheckView, Held, OptionsData, PlanData, Profile } from "@/lib/desk/types";
import { useNow } from "../../charts/hooks";
import c from "./canvas.module.css";
import { Empty, Failure, SectionHead, Working } from "./parts";

interface Props {
  options: Held<OptionsData> | null;
  plan: Held<PlanData> | null;
  planBusy: string | undefined;
  ticketsBusy: string | undefined;
  /** Whether dry-run tickets were already issued (or refused) for the plan on screen. */
  issued: "issued" | "refused" | null;
  error: ApiFailure | undefined;
  profile: Profile;
  onResign: () => void;
  onIssue: () => void;
  onSignBest: () => void;
  onOpenProfile: () => void;
}

const WORD = { allow: "Allowed", hold: "Held", refuse: "Refused" } as const;
const CHECK_NAME: Record<string, string> = {
  DATA_STALE: "Fresh data",
  VENUE_CLOSED: "Venue open",
  BOOK_EXHAUSTED: "Book depth",
  COST_CAP: "Cost cap",
  PARTICIPATION: "Participation",
  EVENT_WINDOW: "Event window",
  PRICE_INTEGRITY: "Price integrity",
  PROFILE: "Profile",
  DEADLINE: "Deadline",
  SOURCE_MISSING: "Critical sources",
};

function Glyph({ verdict, size = 30 }: { verdict: string; size?: number }) {
  // fair current (chevrons) / slack water (≈) / overfalls (broken rip)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 30 30"
      aria-hidden="true"
      className={c.verdictGlyph}
      data-verdict={verdict}
    >
      {verdict === "allow" ? (
        <path
          d="M5 9 L13 15 L5 21 M15 9 L23 15 L15 21"
          fill="none"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      ) : verdict === "hold" ? (
        <path
          d="M4 12 C8 8 12 16 16 12 S24 8 26 11 M4 19 C8 15 12 23 16 19 S24 15 26 18"
          fill="none"
          strokeWidth="2.2"
        />
      ) : (
        <path
          d="M4 7 L11 14 L6 17 L14 25 M14 5 L20 12 L15 15 L25 25"
          fill="none"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function StatusMark({ status }: { status: string }) {
  return (
    <span className={c.checkMark} data-status={status}>
      <span aria-hidden="true">{status === "pass" ? "✓" : status === "hold" ? "≈" : "✕"}</span>
      {status}
    </span>
  );
}

function CheckRow({ ck }: { ck: CheckView }) {
  return (
    <li className={c.check} data-status={ck.status}>
      <StatusMark status={ck.status} />
      <div className={c.checkBody}>
        <p className={c.checkName}>
          {CHECK_NAME[ck.code] ?? ck.code} <code className={c.code}>{ck.code}</code>
        </p>
        <p className={c.checkDetail}>{ck.detail}</p>
        {ck.fix ? <p className={c.checkFix}>Fix: {ck.fix}</p> : null}
      </div>
    </li>
  );
}

export function GateSection(props: Props) {
  const { options, plan, planBusy, ticketsBusy, error } = props;
  const now = useNow(250);
  const preview = !plan && options?.data.gate ? options.data.gate : null;
  const verdict = plan?.data.verdict ?? preview?.verdict ?? null;
  const checks = plan?.data.checks ?? preview?.checks ?? [];
  const blocking = checks.filter((k) => k.status !== "pass");
  const sorted = [
    ...blocking.filter((k) => k.status === "refuse"),
    ...blocking.filter((k) => k.status === "hold"),
    ...checks.filter((k) => k.status === "pass"),
  ];

  // Countdown on the client clock, anchored at the moment the signed plan arrived.
  let remaining = 0;
  let ttl = 60_000;
  if (plan) {
    const sp = plan.data.signedPlan;
    ttl = Math.max(1, plan.data.expiresAt - sp.issuedAt);
    remaining = Math.max(0, ttl - (now - plan.at));
  }
  const expired = !!plan && remaining <= 0;
  const canIssue = !!plan && plan.data.verdict === "allow" && !expired && !ticketsBusy;

  return (
    <section className={c.section} aria-labelledby="h-gate" id="desk-gate">
      <SectionHead
        id="h-gate"
        title="Gate"
        lede="Code checks the plan before anyone can act on it, and fails closed: missing or stale data holds or refuses, it never fills in a default."
        aside={
          plan ? (
            <span className={c.status}>signed plan {plan.data.planId}</span>
          ) : preview && !error ? (
            <span className={c.status}>preview of the lowest-score plan, not signed</span>
          ) : null
        }
      />
      {planBusy && !plan ? (
        <Working
          text={`Gating ${planBusy === "best" ? "the best plan" : planBusy} on fresh books and signing it with the desk key…`}
          rows={3}
        />
      ) : error && !plan ? (
        <Failure error={error} what="Could not build the plan" />
      ) : !verdict ? (
        <Empty>
          <p>The gate runs once an order is priced. Its verdict decides whether tickets can be issued.</p>
        </Empty>
      ) : (
        <div className={c.gate} data-verdict={verdict}>
          <div className={c.verdictRow}>
            <div className={c.verdictMain}>
              <Glyph verdict={verdict} size={verdict === "refuse" ? 40 : 32} />
              <div>
                <p className={c.verdictWord}>{WORD[verdict]}</p>
                <p className={c.verdictLine}>
                  {verdict === "allow"
                    ? `All ${checks.length} checks pass${plan ? ` for ${plan.data.strategy.label}` : ""}.`
                    : `${blocking.length} of ${checks.length} checks ${verdict === "refuse" ? "refuse" : "hold"} ${plan ? plan.data.strategy.label : "the lowest-score plan"}.`}
                </p>
              </div>
            </div>
            {plan ? (
              <dl className={c.signature}>
                <div>
                  <dt>Plan hash</dt>
                  <dd className={c.mono}>{plan.data.signedPlan.hash.slice(0, 16)}…</dd>
                </div>
                <div>
                  <dt>Ed25519 signature</dt>
                  <dd className={c.mono}>{plan.data.signedPlan.sig.slice(0, 16)}…</dd>
                </div>
                <div>
                  <dt>Key</dt>
                  <dd className={c.mono}>
                    {plan.data.publicKey.slice(0, 10)}… (
                    {plan.data.keyOrigin === "ephemeral"
                      ? "ephemeral, this server instance"
                      : "desk signing key"}
                    )
                  </dd>
                </div>
                <div>
                  <dt>Signed</dt>
                  <dd className={c.mono}>{nyClock(plan.data.signedPlan.issuedAt)} NY</dd>
                </div>
              </dl>
            ) : null}
          </div>

          {verdict !== "allow" && blocking[0] ? (
            <div className={c.blocker}>
              <p className={c.blockerHead}>
                {CHECK_NAME[blocking[0].code] ?? blocking[0].code}{" "}
                {blocking[0].status === "refuse" ? "refused" : "held"} the plan
              </p>
              <p className={c.blockerDetail}>{blocking[0].detail}</p>
              {blocking[0].fix ? <p className={c.blockerFix}>{blocking[0].fix}</p> : null}
              {blocking.some((b) => b.code === "COST_CAP" || b.code === "PROFILE") ? (
                <button type="button" className={c.ghostBtn} onClick={props.onOpenProfile}>
                  Review your profile (cost cap {bps(props.profile.costCapBps)})
                </button>
              ) : null}
            </div>
          ) : null}

          <ol className={c.checks}>
            {sorted.map((ck) => (
              <CheckRow key={ck.code} ck={ck} />
            ))}
          </ol>

          {error ? <Failure error={error} what="Could not sign a new plan" /> : null}
          <div className={c.gateActions}>
            {plan ? (
              <>
                <div className={c.expiry} data-expired={expired ? "true" : "false"}>
                  <span className={c.expiryBar} aria-hidden="true">
                    <span style={{ transform: `scaleX(${remaining / ttl})` }} />
                  </span>
                  <span className={c.expiryText} aria-live="off">
                    {expired
                      ? "Signature expired: tickets need a plan signed in the last minute."
                      : `Ticketable for ${Math.ceil(remaining / 1000)} s more`}
                  </span>
                </div>
                <div className={c.btnRow}>
                  <button
                    type="button"
                    className={c.ghostBtn}
                    onClick={props.onResign}
                    disabled={!!planBusy || !!ticketsBusy}
                  >
                    {planBusy ? "Re-signing…" : "Re-sign on fresh books"}
                  </button>
                  {props.issued ? (
                    <button
                      type="button"
                      className={c.ghostBtn}
                      onClick={() => scrollToSection("desk-tickets")}
                    >
                      {props.issued === "issued"
                        ? "Tickets issued: see them below"
                        : "Tickets refused: see why below"}
                    </button>
                  ) : (
                    <button type="button" className={c.primary} onClick={props.onIssue} disabled={!canIssue}>
                      {ticketsBusy ? "Issuing…" : "Issue dry-run tickets"}
                    </button>
                  )}
                </div>
                {plan.data.verdict !== "allow" ? (
                  <p className={c.note}>
                    Tickets are refused while the gate says {plan.data.verdict.toUpperCase()}. That is the
                    point.
                  </p>
                ) : null}
              </>
            ) : (
              <div className={c.btnRow}>
                <button
                  type="button"
                  className={c.primary}
                  onClick={props.onSignBest}
                  disabled={!!planBusy || !options?.data.best}
                >
                  {planBusy
                    ? "Signing…"
                    : `Gate and sign ${options?.data.best ? familyName(options.data.best.kind, options.data.best.id).toLowerCase() : "the best plan"}`}
                </button>
              </div>
            )}
          </div>
          {plan ? (
            <p className={c.note}>
              Expires {nyDayTime(plan.data.expiresAt).slice(0, 3)} {nyClock(plan.data.expiresAt)} NY on the
              server clock; received {age(now - plan.at)} ago.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
