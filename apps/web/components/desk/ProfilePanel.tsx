"use client";
// The trader's standing preferences. Every price, plan and chat turn is computed against this profile; it lives
// in this browser only (localStorage), and changes apply to the next request.
import { useId, useState } from "react";
import { sessionLabel } from "@/lib/desk/format";
import { PRESETS, SESSIONS_AVOIDABLE } from "@/lib/desk/profile";
import type { Profile, Session } from "@/lib/desk/types";
import s from "./sheet.module.css";

interface Props {
  profile: Profile;
  presetId: string | null;
  onChange: (p: Profile, presetId: string | null) => void;
  onClose: () => void;
}

export function ProfilePanel({ profile, presetId, onChange, onClose }: Props) {
  const id = useId();
  const edit = (patch: Partial<Profile>) => onChange({ ...profile, ...patch, name: "custom" }, null);
  const toggleSession = (sess: Session) => {
    const has = profile.avoidSessions.includes(sess);
    edit({
      avoidSessions: has ? profile.avoidSessions.filter((x) => x !== sess) : [...profile.avoidSessions, sess],
    });
  };
  return (
    <section className={s.profile} aria-labelledby={`${id}-h`}>
      <div className={s.profileHead}>
        <h2 id={`${id}-h`} className={s.profileTitle}>
          Your profile
        </h2>
        <button type="button" className={s.textBtn} onClick={onClose}>
          Done
        </button>
      </div>
      <p className={s.profileNote}>
        The desk prices, gates and chats against this. It stays in this browser.
      </p>
      <fieldset className={s.presets}>
        <legend className={s.fieldLabel}>Start from</legend>
        {PRESETS.map((p) => (
          <label key={p.id} className={presetId === p.id ? `${s.preset} ${s.presetOn}` : s.preset}>
            <input
              type="radio"
              name={`${id}-preset`}
              checked={presetId === p.id}
              onChange={() => onChange(p.profile, p.id)}
            />
            <span className={s.presetTitle}>{p.title}</span>
            <span className={s.presetBlurb}>{p.blurb}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className={s.field}>
        <legend className={s.fieldLabel}>Urgency</legend>
        <div className={s.segmented}>
          {(["patient", "normal", "urgent"] as const).map((u) => (
            <label key={u} className={profile.urgency === u ? `${s.seg} ${s.segOn}` : s.seg}>
              <input
                type="radio"
                name={`${id}-urg`}
                checked={profile.urgency === u}
                onChange={() => edit({ urgency: u })}
              />
              {u}
            </label>
          ))}
        </div>
      </fieldset>

      <div className={s.fieldRow}>
        <div className={s.field}>
          <label className={s.fieldLabel} htmlFor={`${id}-cap`}>
            Cost cap
          </label>
          <span className={s.inputUnit}>
            <NumberInput
              id={`${id}-cap`}
              value={profile.costCapBps}
              min={0.5}
              max={1000}
              step={0.5}
              onCommit={(v) => edit({ costCapBps: v })}
            />
            <span>bp</span>
          </span>
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel} htmlFor={`${id}-part`}>
            Max participation
          </label>
          <span className={s.inputUnit}>
            <NumberInput
              id={`${id}-part`}
              value={Math.round(profile.maxParticipation * 1000) / 10}
              min={1}
              max={100}
              step={1}
              onCommit={(v) => edit({ maxParticipation: v / 100 })}
            />
            <span>%</span>
          </span>
        </div>
      </div>

      <div className={s.checks}>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={profile.allowPerp}
            onChange={(e) => edit({ allowPerp: e.target.checked })}
          />
          Perps allowed
        </label>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={profile.avoidEvents}
            onChange={(e) => edit({ avoidEvents: e.target.checked })}
          />
          Hold around earnings, dividends and macro events
        </label>
      </div>

      <fieldset className={s.field}>
        <legend className={s.fieldLabel}>Never trade in</legend>
        <div className={s.chipsRow}>
          {SESSIONS_AVOIDABLE.map((sess) => (
            <label
              key={sess}
              className={profile.avoidSessions.includes(sess) ? `${s.toggle} ${s.toggleOn}` : s.toggle}
            >
              <input
                type="checkbox"
                checked={profile.avoidSessions.includes(sess)}
                onChange={() => toggleSession(sess)}
              />
              {sessionLabel(sess)}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

/** A number field that lets the trader type freely; valid values apply as typed, the field resets on blur. */
function NumberInput({
  id,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= min && v <= max) onCommit(v);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
