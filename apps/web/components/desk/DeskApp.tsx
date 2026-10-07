"use client";
// The desk: a conversation sheet docked beside the plan canvas. Both drive one canvas state — tool results from
// the conversation and direct API calls from the order line land in the same reducer, so the canvas always shows
// the latest real market, options, plan and tickets, whichever way they were asked for.
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { client, failure } from "@/lib/desk/api";
import { type Focus, intentOfInput, toolPart } from "@/lib/desk/chat";
import { compactMessages } from "@/lib/desk/compact";
import {
  DEFAULT_PROFILE,
  loadProfile,
  presetOf,
  type StoredProfile,
  saveProfile,
  validProfile,
} from "@/lib/desk/profile";
import { scrollToSection } from "@/lib/desk/scroll";
import { deskReducer, initialState } from "@/lib/desk/store";
import type { Held, IntentRequest, Loadable, Profile } from "@/lib/desk/types";
import { useLightTheme, useReducedMotion } from "../charts/hooks";
import { ConversationSheet } from "./ConversationSheet";
import { PlanCanvas } from "./canvas/PlanCanvas";
import s from "./desk.module.css";

const MARKET_REFRESH_MS = 20_000;

const TOOL_TARGET: Partial<Record<string, Loadable>> = {
  price_options: "options",
  build_plan: "plan",
  issue_tickets: "tickets",
  liquidity_tide: "tide",
  market_state: "market",
  research: "research",
};

export function DeskApp() {
  const [state, dispatch] = useReducer(deskReducer, undefined, () => initialState("NVDA"));
  const light = useLightTheme();
  const reduced = useReducedMotion();

  // ---- profile (localStorage, read after mount so server and first client render agree) ---------------------
  const [stored, setStored] = useState<StoredProfile>({
    presetId: null,
    profile: DEFAULT_PROFILE,
    answered: {},
  });
  useEffect(() => {
    const got = loadProfile();
    if (got) setStored(got);
  }, []);
  const updateStored = useCallback((f: (s: StoredProfile) => StoredProfile) => {
    setStored((prev) => {
      const next = f(prev);
      saveProfile(next);
      return next;
    });
  }, []);
  const profile = stored.profile;
  const profileRef = useRef(profile);
  profileRef.current = profile;

  // ---- conversation ----------------------------------------------------------------------------------------
  const [transport] = useState(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages: compactMessages(messages), profile: profileRef.current },
        }),
      }),
  );
  const chat = useChat({ transport, throttle: 60 });
  const { messages, status, error } = chat;

  // Tool timings and canvas sync: every finished tool envelope is copied onto the canvas once.
  const timesRef = useRef<Record<string, { start: number; end?: number }>>({});
  const [toolTimes, setToolTimes] = useState<Record<string, { start: number; end?: number }>>({});
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let changed = false;
    const now = Date.now();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts) {
        const t = toolPart(p);
        if (!t) continue;
        const rec = timesRef.current[t.toolCallId];
        if (!rec && (t.state === "input-available" || t.state === "input-streaming")) {
          timesRef.current[t.toolCallId] = { start: now };
          changed = true;
        }
        if (t.state === "output-available" || t.state === "output-error") {
          const r = timesRef.current[t.toolCallId] ?? { start: now };
          if (r.end === undefined) {
            timesRef.current[t.toolCallId] = { ...r, end: now };
            changed = true;
          }
        }
        if (t.state !== "output-available" || !t.envelope || seenRef.current.has(t.toolCallId)) continue;
        seenRef.current.add(t.toolCallId);
        const env = t.envelope;
        const key = TOOL_TARGET[env.tool];
        if (!key) {
          dispatch({ type: "sources", sources: env.sources, via: env.tool });
          continue;
        }
        if (!env.ok && env.error && env.data === undefined) {
          dispatch({
            type: "error",
            key,
            error: { status: 0, code: env.error.code, message: env.error.message, sources: env.sources },
          });
          dispatch({ type: "sources", sources: env.sources, via: env.tool });
          continue;
        }
        const held: Held<unknown> = {
          data: env.data,
          sources: env.sources,
          origin: "chat",
          at: now,
          callId: t.toolCallId,
        };
        const intent = intentOfInput(t.input);
        if (intent && (key === "options" || key === "plan")) held.intent = intent;
        dispatch({ type: "held", key: key as "options", held: held as Held<never>, via: `chat ${env.tool}` });
      }
    }
    if (changed) setToolTimes({ ...timesRef.current });
  }, [messages]);

  // A tool still running in the conversation shows on the canvas as that section's busy state.
  const chatBusy = useMemo(() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || (status !== "streaming" && status !== "submitted")) return {};
    const out: Partial<Record<Loadable, string>> = {};
    for (const p of last.parts) {
      const t = toolPart(p);
      if (!t || (t.state !== "input-streaming" && t.state !== "input-available")) continue;
      const key = TOOL_TARGET[t.tool];
      if (key) out[key] = "chat";
    }
    return out;
  }, [messages, status]);

  // ---- symbol data: live market (refreshed), tide and research ---------------------------------------------
  const symbol = state.symbol;
  useEffect(() => {
    const ac = new AbortController();
    const load = async <K extends "market" | "tide" | "research">(
      key: K,
      f: () => Promise<{ data: unknown; sources: Held<unknown>["sources"] }>,
    ) => {
      dispatch({ type: "busy", key, label: "loading" });
      try {
        const r = await f();
        if (ac.signal.aborted) return;
        dispatch({
          type: "held",
          key,
          held: { data: r.data, sources: r.sources, origin: "form", at: Date.now() },
          via: key,
        });
      } catch (e) {
        if (ac.signal.aborted) return;
        const err = failure(e);
        dispatch({ type: "error", key, error: err });
        dispatch({ type: "sources", sources: err.sources, via: key });
      } finally {
        if (!ac.signal.aborted) dispatch({ type: "busy", key, label: null });
      }
    };
    void load("market", () => client.market(symbol, ac.signal));
    void load("tide", () => client.tide(symbol, ac.signal));
    void load("research", () => client.research(symbol, ac.signal));
    const id = window.setInterval(() => {
      if (document.hidden) return;
      client
        .market(symbol, ac.signal)
        .then((r) => {
          if (!ac.signal.aborted)
            dispatch({
              type: "held",
              key: "market",
              held: { data: r.data, sources: r.sources, origin: "form", at: Date.now() },
              via: "market",
            });
        })
        .catch(() => {
          /* a missed refresh keeps the last book on screen with its age */
        });
    }, MARKET_REFRESH_MS);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [symbol]);

  // ---- canvas actions (order line + buttons) -----------------------------------------------------------------
  // Only the latest call per action lands, and only while what it was asked for is still on screen: a plan is
  // for the options it was signed from, tickets are for the plan they were issued against.
  const genRef = useRef({ options: 0, plan: 0, tickets: 0 });
  const basisRef = useRef<Record<"options" | "plan" | "tickets", unknown>>({
    options: null,
    plan: null,
    tickets: null,
  });
  basisRef.current = {
    options: null,
    plan: state.options?.at ?? null,
    tickets: state.plan?.data.planId ?? null,
  };
  const run = useCallback(
    async <T,>(
      key: "options" | "plan" | "tickets",
      label: string,
      f: () => Promise<{ data: T; sources: Held<T>["sources"] }>,
      intent?: IntentRequest,
    ) => {
      const gen = ++genRef.current[key];
      const basis = basisRef.current[key];
      const live = () => genRef.current[key] === gen && basisRef.current[key] === basis;
      dispatch({ type: "busy", key, label });
      dispatch({ type: "error", key, error: null });
      try {
        const r = await f();
        if (!live()) return;
        const held: Held<unknown> = { data: r.data, sources: r.sources, origin: "form", at: Date.now() };
        if (intent) held.intent = intent;
        dispatch({ type: "held", key, held: held as Held<never>, via: key });
      } catch (e) {
        if (!live()) return;
        const err = failure(e);
        dispatch({ type: "error", key, error: err });
        dispatch({ type: "sources", sources: err.sources, via: key });
      } finally {
        if (genRef.current[key] === gen) dispatch({ type: "busy", key, label: null });
      }
    },
    [],
  );

  const priceOrder = useCallback(
    (intent: IntentRequest) => {
      dispatch({ type: "symbol", symbol: intent.symbol });
      void run("options", "pricing", () => client.options({ intent, profile: profileRef.current }), intent);
    },
    [run],
  );

  const optionsIntent = state.options?.intent ?? null;
  const planIntent = state.plan?.intent ?? null;
  const signStrategy = useCallback(
    (strategyId: string, intent: IntentRequest | null) => {
      const it = intent ?? optionsIntent ?? planIntent;
      if (!it) return;
      void run(
        "plan",
        strategyId,
        () => client.plan({ intent: it, profile: profileRef.current, strategyId }),
        it,
      );
    },
    [run, optionsIntent, planIntent],
  );
  const signedPlan = state.plan?.data.signedPlan ?? null;
  const issueTickets = useCallback(() => {
    if (!signedPlan) return;
    void run("tickets", "issuing", () => client.tickets({ signedPlan }));
  }, [run, signedPlan]);

  // ---- layout state ----------------------------------------------------------------------------------------
  const [sheetOpen, setSheetOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const focus = useCallback(
    (f: Focus) => {
      if (!f) return;
      if (f === "profile") {
        setProfileOpen(true);
        return;
      }
      setSheetOpen(false);
      window.requestAnimationFrame(() => scrollToSection(`desk-${f}`, !reduced));
    },
    [reduced],
  );

  const send = useCallback(
    (text: string) => {
      setSheetOpen(true);
      void chat.sendMessage({ text });
    },
    [chat],
  );

  const onProfile = useCallback(
    (p: Profile, presetId: string | null) => updateStored((st) => ({ ...st, profile: p, presetId })),
    [updateStored],
  );
  const onAnswer = useCallback(
    (callId: string, answer: "applied" | "declined", patch?: Partial<Profile>) =>
      updateStored((st) => {
        const answered = { ...st.answered, [callId]: answer };
        if (answer !== "applied" || !patch) return { ...st, answered };
        const next = validProfile({ ...st.profile, ...patch, name: "custom" });
        if (!next) return { ...st, answered: { ...st.answered, [callId]: "declined" } };
        return { profile: next, presetId: presetOf(next)?.id ?? null, answered };
      }),
    [updateStored],
  );

  const busy = { ...state.busy, ...chatBusy };

  return (
    <div className={s.desk}>
      <ConversationSheet
        messages={messages}
        status={status}
        error={error}
        toolTimes={toolTimes}
        profile={profile}
        presetId={stored.presetId}
        onProfile={onProfile}
        answered={stored.answered}
        onAnswer={onAnswer}
        onSend={send}
        onStop={() => void chat.stop()}
        onRetry={() => {
          chat.clearError();
          void chat.regenerate();
        }}
        onNew={() => {
          chat.setMessages([]);
          chat.clearError();
        }}
        onFocus={focus}
        open={sheetOpen}
        setOpen={setSheetOpen}
        profileOpen={profileOpen}
        setProfileOpen={setProfileOpen}
      />
      <PlanCanvas
        state={state}
        busy={busy}
        profile={profile}
        light={light}
        reduced={reduced}
        onPrice={priceOrder}
        onSign={signStrategy}
        onIssue={issueTickets}
        onOpenProfile={() => {
          setProfileOpen(true);
          setSheetOpen(true);
        }}
      />
    </div>
  );
}
