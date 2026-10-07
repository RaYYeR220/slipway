"use client";
// The order, written as a sentence the trader can edit: the same intent the conversation extracts, priced
// directly against /api/plan/options without the model.
import { type FormEvent, useId, useState } from "react";
import type { IntentRequest, Profile, Venue } from "@/lib/desk/types";
import c from "./canvas.module.css";

export const UNIVERSE = [
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "META",
  "AMD",
  "MU",
  "INTC",
  "MSTR",
  "COIN",
  "CRCL",
  "HOOD",
  "PLTR",
  "SPY",
  "QQQ",
  "SOXL",
];

const DEADLINES = ["today", "before the open", "in 2h", "tomorrow", "before thursday", "by friday"];

interface Props {
  initial: IntentRequest | null;
  symbol: string;
  profile: Profile;
  busy: boolean;
  onSubmit: (i: IntentRequest) => void;
}

export function OrderLine({ initial, symbol, profile, busy, onSubmit }: Props) {
  const id = useId();
  const [side, setSide] = useState<"buy" | "sell">(initial?.side ?? "buy");
  const [unit, setUnit] = useState<"usd" | "qty">(initial?.qty !== undefined ? "qty" : "usd");
  const [amount, setAmount] = useState<string>(String(initial?.qty ?? initial?.notionalUsd ?? 40000));
  const [sym, setSym] = useState(initial?.symbol?.toUpperCase() ?? symbol);
  const [deadline, setDeadline] = useState(initial?.deadline ?? "");
  const [venues, setVenues] = useState<Record<Venue, boolean>>({
    rtoken: initial?.venues ? initial.venues.includes("rtoken") : true,
    perp: initial?.venues ? initial.venues.includes("perp") : true,
  });
  const [urgency, setUrgency] = useState<"" | "patient" | "normal" | "urgent">(initial?.urgency ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount.replace(/[,\s$]/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      setProblem(unit === "usd" ? "Enter a dollar amount above zero." : "Enter a share count above zero.");
      return;
    }
    const v = (Object.keys(venues) as Venue[]).filter((k) => venues[k]);
    if (!v.length) {
      setProblem("Pick at least one venue.");
      return;
    }
    setProblem(null);
    const intent: IntentRequest = { symbol: sym, side };
    if (unit === "usd") intent.notionalUsd = n;
    else intent.qty = n;
    if (deadline.trim()) intent.deadline = deadline.trim().slice(0, 40);
    if (v.length === 1) intent.venues = v;
    if (urgency) intent.urgency = urgency;
    onSubmit(intent);
  };

  return (
    <form className={c.orderLine} onSubmit={submit} aria-label="Order">
      <div className={c.sentence}>
        <label className={c.sr} htmlFor={`${id}-side`}>
          Side
        </label>
        <select
          id={`${id}-side`}
          className={`${c.word} ${side === "buy" ? c.buyWord : c.sellWord}`}
          value={side}
          onChange={(e) => setSide(e.target.value as "buy" | "sell")}
        >
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <span className={c.amountGroup}>
          {unit === "usd" ? <span className={c.prefix}>$</span> : null}
          <label className={c.sr} htmlFor={`${id}-amt`}>
            Size
          </label>
          <input
            id={`${id}-amt`}
            className={`${c.word} ${c.amount}`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            size={Math.max(3, amount.length)}
          />
          <label className={c.sr} htmlFor={`${id}-unit`}>
            Unit
          </label>
          <select
            id={`${id}-unit`}
            className={`${c.word} ${c.small}`}
            value={unit}
            onChange={(e) => setUnit(e.target.value as "usd" | "qty")}
          >
            <option value="usd">dollars</option>
            <option value="qty">shares</option>
          </select>
        </span>
        <span className={c.joiner}>of</span>
        <label className={c.sr} htmlFor={`${id}-sym`}>
          Stock
        </label>
        <select id={`${id}-sym`} className={c.word} value={sym} onChange={(e) => setSym(e.target.value)}>
          {UNIVERSE.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <span className={c.joiner}>done</span>
        <label className={c.sr} htmlFor={`${id}-dl`}>
          Deadline
        </label>
        <input
          id={`${id}-dl`}
          className={`${c.word} ${c.deadline}`}
          list={`${id}-dls`}
          placeholder="whenever"
          value={deadline}
          maxLength={40}
          onChange={(e) => setDeadline(e.target.value)}
          size={Math.max(10, deadline.length + 1)}
        />
        <datalist id={`${id}-dls`}>
          {DEADLINES.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </div>
      <div className={c.orderControls}>
        <fieldset className={c.venuePick}>
          <legend className={c.sr}>Venues</legend>
          {(["rtoken", "perp"] as Venue[]).map((v) => (
            <label key={v} className={venues[v] ? `${c.pill} ${c.pillOn}` : c.pill}>
              <input
                type="checkbox"
                checked={venues[v]}
                onChange={(e) => setVenues((p) => ({ ...p, [v]: e.target.checked }))}
              />
              {v === "rtoken" ? `r${sym} spot` : `${sym} perp`}
            </label>
          ))}
        </fieldset>
        <label className={c.urgencyPick}>
          <span className={c.sr}>Urgency</span>
          <select value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
            <option value="">urgency from profile ({profile.urgency})</option>
            <option value="patient">patient</option>
            <option value="normal">normal</option>
            <option value="urgent">urgent</option>
          </select>
        </label>
        <button type="submit" className={c.priceBtn} disabled={busy}>
          {busy ? "Pricing…" : "Price every option"}
        </button>
      </div>
      {venues.perp && !profile.allowPerp ? (
        <p className={c.hint}>
          Your profile does not allow perps, so the desk will not choose a perp strategy.
        </p>
      ) : null}
      {problem ? (
        <p className={c.formError} role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
