"use client";
// The conversation, docked as a sheet (left on desktop, a bottom sheet on phones). It shows the trader's words,
// a compact timeline of every tool the desk ran, and the desk's reply rendered from data-render parts only.
import type { UIMessage } from "ai";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { chatFailure } from "@/lib/desk/api";
import {
  type Focus,
  renderedOf,
  repairOf,
  sourceCounts,
  summarize,
  type ToolPartView,
  textOf,
  toolPart,
} from "@/lib/desk/chat";
import { age, bps, pluralize, sessionLabel } from "@/lib/desk/format";
import { presetOf } from "@/lib/desk/profile";
import type { Profile, ProfileProposal } from "@/lib/desk/types";
import { ProfilePanel } from "./ProfilePanel";
import { RenderedText } from "./RenderedText";
import s from "./sheet.module.css";

export const SUGGESTIONS = [
  "I want $40k of NVDA before Thursday, no perps, I'm patient",
  "Sell 300 TSLA as cheaply as possible today",
  "What does it cost to buy $250k of MSTR right now vs at the open?",
  "Купи AAPL на $15k до пятницы, только спот, я не спешу",
];

type Status = "submitted" | "streaming" | "ready" | "error";

interface Props {
  messages: UIMessage[];
  status: Status;
  error: Error | undefined;
  toolTimes: Record<string, { start: number; end?: number }>;
  profile: Profile;
  presetId: string | null;
  onProfile: (p: Profile, presetId: string | null) => void;
  answered: Record<string, "applied" | "declined">;
  onAnswer: (callId: string, answer: "applied" | "declined", patch?: Partial<Profile>) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onNew: () => void;
  onFocus: (f: Focus) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  profileOpen: boolean;
  setProfileOpen: (open: boolean) => void;
}

export function ConversationSheet(props: Props) {
  const { messages, status, error, open, setOpen, profileOpen, setProfileOpen } = props;
  const logRef = useRef<HTMLDivElement | null>(null);
  const busy = status === "submitted" || status === "streaming";
  const preset = presetOf(props.profile);
  const failure = chatFailure(error);

  // Follow the conversation while the reader is at the bottom.
  const last = messages[messages.length - 1];
  const lastLen = last ? last.parts.length : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever a message, a part or the status arrives
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 220 || lastLen <= 1)
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, lastLen, status]);

  return (
    <aside className={s.sheet} data-open={open ? "true" : "false"} aria-label="Conversation with the desk">
      <button type="button" className={s.grab} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={s.grabBar} aria-hidden="true" />
        <span className={s.grabText}>
          {open
            ? "Show the plan"
            : messages.length
              ? `Conversation, ${pluralize(messages.length, "message")}`
              : "Ask the desk"}
        </span>
        {busy ? <span className={s.grabBusy}>working</span> : null}
      </button>
      <header className={s.head}>
        <h2 className={s.title}>Conversation</h2>
        <div className={s.headActions}>
          <button
            type="button"
            className={s.profileBtn}
            aria-expanded={profileOpen}
            onClick={() => setProfileOpen(!profileOpen)}
          >
            <span className={s.profileBtnLabel}>Profile</span>
            <span className={s.profileBtnValue}>
              {preset ? preset.title : props.profile.name === "default" ? "Default" : "Custom"}
            </span>
          </button>
          <button
            type="button"
            className={s.textBtn}
            onClick={props.onNew}
            disabled={!messages.length || busy}
          >
            New
          </button>
        </div>
      </header>
      {profileOpen ? (
        <ProfilePanel
          profile={props.profile}
          presetId={props.presetId}
          onChange={props.onProfile}
          onClose={() => setProfileOpen(false)}
        />
      ) : null}
      <div className={s.log} ref={logRef} role="log" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 ? <Empty onPick={props.onSend} disabled={busy} /> : null}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={m.id} className={s.user}>
              <span className={s.who}>You</span>
              <p className={s.userText}>{textOf(m)}</p>
            </div>
          ) : (
            <AssistantMessage
              key={m.id}
              m={m}
              live={busy && i === messages.length - 1}
              toolTimes={props.toolTimes}
              answered={props.answered}
              onAnswer={props.onAnswer}
              onFocus={props.onFocus}
              profile={props.profile}
            />
          ),
        )}
        {status === "submitted" && last?.role === "user" ? (
          <div className={s.assistant}>
            <span className={s.who}>Slipway</span>
            <Working label="reading your order" />
          </div>
        ) : null}
        {failure ? (
          <div className={s.failure} role="alert">
            <p>{failure.message}</p>
            {failure.retryable ? (
              <button type="button" className={s.textBtn} onClick={props.onRetry}>
                Send again
              </button>
            ) : (
              <button type="button" className={s.textBtn} onClick={props.onNew}>
                Start a new conversation
              </button>
            )}
          </div>
        ) : null}
      </div>
      <Composer busy={busy} onSend={props.onSend} onStop={props.onStop} />
    </aside>
  );
}

function Empty({ onPick, disabled }: { onPick: (t: string) => void; disabled: boolean }) {
  return (
    <div className={s.empty}>
      <p className={s.emptyLead}>Tell the desk what you want to trade, in your own words.</p>
      <p className={s.emptyBody}>
        It prices every venue, session and slicing against the live Bitget book, gates the plan in code and
        writes a dry-run ticket for each slice. Nothing is sent to the exchange.
      </p>
      <p className={s.emptyTry}>Try one</p>
      <ul className={s.suggestions}>
        {SUGGESTIONS.map((q) => (
          <li key={q}>
            <button type="button" className={s.suggestion} onClick={() => onPick(q)} disabled={disabled}>
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Working({ label }: { label: string }) {
  return (
    <p className={s.working}>
      <span className={s.dots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </p>
  );
}

function AssistantMessage({
  m,
  live,
  toolTimes,
  answered,
  onAnswer,
  onFocus,
  profile,
}: {
  m: UIMessage;
  live: boolean;
  toolTimes: Props["toolTimes"];
  answered: Props["answered"];
  onAnswer: Props["onAnswer"];
  onFocus: Props["onFocus"];
  profile: Profile;
}) {
  const tools = m.parts.map(toolPart).filter((t): t is ToolPartView => t !== null);
  const rendered = renderedOf(m);
  const repair = repairOf(m);
  const typed = repair?.flags.length ?? 0;
  return (
    <div className={s.assistant}>
      <span className={s.who}>Slipway</span>
      {tools.length ? (
        <ol className={s.timeline} aria-label="Tools the desk ran">
          {tools.map((t) => (
            <ToolRow key={t.toolCallId} t={t} times={toolTimes[t.toolCallId]} onFocus={onFocus} />
          ))}
        </ol>
      ) : null}
      {tools
        .filter((t) => t.tool === "propose_profile_update" && t.envelope?.ok && t.envelope.data)
        .map((t) => (
          <Proposal
            key={`p-${t.toolCallId}`}
            callId={t.toolCallId}
            data={t.envelope?.data as ProfileProposal}
            answered={answered[t.toolCallId]}
            onAnswer={onAnswer}
            profile={profile}
          />
        ))}
      {rendered ? (
        <>
          <RenderedText parts={rendered.parts} />
          {typed ? (
            <p className={s.repairNote}>
              The first draft typed {pluralize(typed, "figure")} instead of citing a tool; the desk had it
              rewritten.
              {rendered.flags.length ? " What still could not be verified is struck out." : ""}
            </p>
          ) : null}
        </>
      ) : live ? (
        <Working
          label={
            tools.some((t) => t.state !== "output-available" && t.state !== "output-error")
              ? "waiting on the desk"
              : "drafting the reply; every figure is filled in from the tool results"
          }
        />
      ) : (
        <p className={s.muted}>No reply was rendered for this turn.</p>
      )}
    </div>
  );
}

function ToolRow({
  t,
  times,
  onFocus,
}: {
  t: ToolPartView;
  times: { start: number; end?: number } | undefined;
  onFocus: (f: Focus) => void;
}) {
  const sum = summarize(t);
  const running = t.state === "input-streaming" || t.state === "input-available";
  const failed = t.state === "output-error" || (t.envelope ? !t.envelope.ok && !!t.envelope.error : false);
  const counts = t.envelope ? sourceCounts(t.envelope.sources) : null;
  const dur = times?.end && times.start ? age(times.end - times.start) : null;
  const meta: string[] = [];
  if (dur) meta.push(dur);
  if (counts && counts.live + counts.cached + counts.unavailable > 0) {
    const bits = [`${counts.live} live`];
    if (counts.cached) bits.push(`${counts.cached} cached`);
    if (counts.unavailable) bits.push(`${counts.unavailable} unavailable`);
    meta.push(`sources: ${bits.join(", ")}`);
  }
  const text =
    t.state === "output-error"
      ? `${t.tool} failed: ${t.errorText ?? "error"}`
      : running
        ? `${sum.running}…`
        : sum.done;
  const clickable = !running && !failed && sum.focus !== null;
  return (
    <li className={s.toolItem}>
      <button
        type="button"
        className={s.toolRow}
        data-state={running ? "running" : failed ? "failed" : "done"}
        onClick={() => onFocus(sum.focus)}
        disabled={!clickable}
        title={clickable ? "Show this on the plan canvas" : undefined}
      >
        <span className={s.toolGlyph} aria-hidden="true" />
        <span className={s.toolText}>{text}</span>
        {meta.length ? <span className={s.toolMeta}>{meta.join(" · ")}</span> : null}
      </button>
    </li>
  );
}

const FIELD_LABEL: Record<string, string> = {
  urgency: "Urgency",
  costCapBps: "Cost cap",
  maxParticipation: "Max participation",
  allowPerp: "Perps",
  maxLeverage: "Max leverage",
  avoidSessions: "Never trade in",
  avoidEvents: "Hold around events",
};

function fieldValue(k: string, v: unknown): string {
  if (k === "costCapBps" && typeof v === "number") return bps(v);
  if (k === "maxParticipation" && typeof v === "number") return `${Math.round(v * 1000) / 10}%`;
  if (k === "allowPerp") return v ? "allowed" : "not allowed";
  if (k === "avoidEvents") return v ? "yes" : "no";
  if (k === "avoidSessions" && Array.isArray(v))
    return v.length ? v.map((x) => sessionLabel(String(x))).join(", ") : "none";
  return String(v);
}

function Proposal({
  callId,
  data,
  answered,
  onAnswer,
  profile,
}: {
  callId: string;
  data: ProfileProposal;
  answered: "applied" | "declined" | undefined;
  onAnswer: Props["onAnswer"];
  profile: Profile;
}) {
  const { patch, reason, changed } = data.proposal;
  const keys = changed.length ? changed : Object.keys(patch);
  return (
    <div className={s.proposal}>
      <p className={s.proposalHead}>Change your profile?</p>
      {reason ? <p className={s.proposalReason}>Because you said: “{reason}”</p> : null}
      <dl className={s.proposalList}>
        {keys.map((k) => (
          <div key={k} className={s.proposalRow}>
            <dt>{FIELD_LABEL[k] ?? k}</dt>
            <dd>
              <span className={s.was}>
                {fieldValue(k, (profile as unknown as Record<string, unknown>)[k])}
              </span>
              <span aria-hidden="true"> → </span>
              <span className={s.sr}> becomes </span>
              <span>{fieldValue(k, (patch as Record<string, unknown>)[k])}</span>
            </dd>
          </div>
        ))}
      </dl>
      {answered ? (
        <p className={s.proposalDone}>
          {answered === "applied" ? "Applied. The next request uses it." : "Kept your current profile."}
        </p>
      ) : (
        <div className={s.proposalActions}>
          <button type="button" className={s.primaryBtn} onClick={() => onAnswer(callId, "applied", patch)}>
            Apply change
          </button>
          <button type="button" className={s.textBtn} onClick={() => onAnswer(callId, "declined")}>
            Keep current
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({
  busy,
  onSend,
  onStop,
}: {
  busy: boolean;
  onSend: (t: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  // grow with the text, up to six lines
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
    el.style.overflowY = el.scrollHeight > 150 ? "auto" : "hidden";
  }, [text]);
  return (
    <form className={s.composer} onSubmit={submit}>
      <label className={s.sr} htmlFor="desk-composer">
        Message the desk
      </label>
      <textarea
        id="desk-composer"
        ref={ref}
        className={s.input}
        rows={1}
        value={text}
        maxLength={2000}
        placeholder="Your order, in your words…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {busy ? (
        <button type="button" className={s.sendBtn} onClick={onStop}>
          Stop
        </button>
      ) : (
        <button type="submit" className={s.sendBtn} disabled={!text.trim()}>
          Send
        </button>
      )}
      <p className={s.composerNote}>
        Figures in chips are filled in by code from tool results. Hover or focus one for its source.
      </p>
    </form>
  );
}
