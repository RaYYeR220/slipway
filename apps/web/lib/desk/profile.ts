// Trader profile: presets, validation (mirrors the server's ProfileSchema bounds) and localStorage persistence.
import type { Profile, Session } from "./types";

export const SESSIONS_AVOIDABLE: Session[] = ["pre_market", "regular", "after_hours", "overnight", "weekend"];

export interface Preset {
  id: string;
  title: string;
  blurb: string;
  profile: Profile;
}

export const DEFAULT_PROFILE: Profile = {
  name: "default",
  urgency: "normal",
  costCapBps: 25,
  maxParticipation: 0.1,
  allowPerp: true,
  maxLeverage: 1,
  avoidSessions: [],
  avoidEvents: true,
};

export const PRESETS: Preset[] = [
  {
    id: "patient-spot",
    title: "Patient spot holder",
    blurb: "rTokens only, waits for depth, tight cost cap.",
    profile: {
      name: "patient-spot",
      urgency: "patient",
      costCapBps: 15,
      maxParticipation: 0.05,
      allowPerp: false,
      maxLeverage: 1,
      avoidSessions: [],
      avoidEvents: true,
    },
  },
  {
    id: "active-perp",
    title: "Active perp trader",
    blurb: "Perps allowed, trades through events, normal urgency.",
    profile: {
      name: "active-perp",
      urgency: "normal",
      costCapBps: 25,
      maxParticipation: 0.1,
      allowPerp: true,
      maxLeverage: 3,
      avoidSessions: [],
      avoidEvents: false,
    },
  },
  {
    id: "size-mover",
    title: "Size mover",
    blurb: "Large clips, low participation, skips thin overnight and weekend water.",
    profile: {
      name: "size-mover",
      urgency: "normal",
      costCapBps: 40,
      maxParticipation: 0.15,
      allowPerp: true,
      maxLeverage: 1,
      avoidSessions: ["overnight", "weekend"],
      avoidEvents: true,
    },
  },
];

const KEY = "slipway.desk.profile.v1";

const isNum = (v: unknown, lo: number, hi: number, loExclusive = false): v is number =>
  typeof v === "number" && Number.isFinite(v) && (loExclusive ? v > lo : v >= lo) && v <= hi;

/** A profile the server will accept, or null. */
export function validProfile(v: unknown): Profile | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.length < 1 || p.name.length > 40) return null;
  if (p.urgency !== "patient" && p.urgency !== "normal" && p.urgency !== "urgent") return null;
  if (!isNum(p.costCapBps, 0, 1000, true)) return null;
  if (!isNum(p.maxParticipation, 0, 1, true)) return null;
  if (typeof p.allowPerp !== "boolean" || typeof p.avoidEvents !== "boolean") return null;
  if (!isNum(p.maxLeverage, 0, 10)) return null;
  if (
    !Array.isArray(p.avoidSessions) ||
    !p.avoidSessions.every((s) => SESSIONS_AVOIDABLE.includes(s as Session))
  )
    return null;
  return {
    name: p.name,
    urgency: p.urgency,
    costCapBps: p.costCapBps,
    maxParticipation: p.maxParticipation,
    allowPerp: p.allowPerp,
    maxLeverage: p.maxLeverage,
    avoidSessions: [...new Set(p.avoidSessions as Session[])],
    avoidEvents: p.avoidEvents,
  };
}

export interface StoredProfile {
  presetId: string | null;
  profile: Profile;
  /** propose_profile_update calls the trader already answered (toolCallId → applied / declined). */
  answered: Record<string, "applied" | "declined">;
}

export function loadProfile(): StoredProfile | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredProfile>;
    const profile = validProfile(v.profile);
    if (!profile) return null;
    const answered: StoredProfile["answered"] = {};
    for (const [k, a] of Object.entries(v.answered ?? {}))
      if (a === "applied" || a === "declined") answered[k] = a;
    return { presetId: typeof v.presetId === "string" ? v.presetId : null, profile, answered };
  } catch {
    return null;
  }
}

export function saveProfile(s: StoredProfile): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage blocked (private mode): the profile still lives in memory for this visit
  }
}

export function presetOf(p: Profile): Preset | undefined {
  return PRESETS.find((x) => JSON.stringify(x.profile) === JSON.stringify(p));
}
