import { mid } from "./book.js";
import { venueTradable } from "./session.js";
import { atlasKey, type MarketEvent, type MarketSnapshot, type Profile, type Slice } from "./types.js";

export interface ParticipationBreach {
  slice: Slice;
  notionalUsd: number;
  capUsd: number;
  intervalSec: number;
}

const HARD_EVENTS = new Set(["earnings", "ex_dividend", "split"]);

// Cap per child: maxParticipation · venue-native traded notional per minute · interval/60. Venues with no
// recorded prints cannot be capped; they are returned as waived instead of silently passing.
export function participationBreaches(
  slices: readonly Slice[],
  snap: MarketSnapshot,
  profile: Profile,
): { breaches: ParticipationBreach[]; waived: string[]; evaluated: number } {
  const groups = new Map<string, Slice[]>();
  for (const s of slices) {
    if (s.type !== "market" || s.conditional) continue;
    const key = `${s.venue}|${s.side}|${s.leg ?? "entry"}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const breaches: ParticipationBreach[] = [];
  const waived = new Set<string>();
  let evaluated = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    evaluated += group.length;
    const sorted = [...group].sort((a, b) => a.t - b.t);
    sorted.forEach((s, k) => {
      const next = sorted[k + 1];
      const prev = sorted[k - 1];
      const intervalSec = (next ? next.t - s.t : s.t - (prev as Slice).t) / 1000 || 0;
      const flow = snap.atlas[atlasKey(snap.symbol, s.venue, s.session)]?.tradeNotionalPerMin.mean ?? 0;
      const live = snap.books[s.venue];
      if (!(flow > 0) || !live) {
        waived.add(`${s.venue}/${s.session}`);
        return;
      }
      const capUsd = profile.maxParticipation * flow * (intervalSec / 60);
      const notionalUsd = s.qty * mid(live);
      if (notionalUsd > capUsd) breaches.push({ slice: s, notionalUsd, capUsd, intervalSec });
    });
  }
  return { breaches, waived: [...waived].sort(), evaluated };
}

// Earnings, ex-dividend and splits always count; macro events only when the profile opts in.
export function eventConflicts(
  startsAt: number,
  endsAt: number,
  events: readonly MarketEvent[],
  symbol: string,
  profile: Profile,
): MarketEvent[] {
  return events.filter((e) => {
    if (e.symbol !== undefined && e.symbol !== symbol) return false;
    if (!HARD_EVENTS.has(e.kind) && !(e.kind === "macro" && profile.avoidEvents)) return false;
    const lo = e.ts - e.windowSec * 1000;
    const hi = e.ts + e.windowSec * 1000;
    return startsAt <= hi && endsAt >= lo;
  });
}

export const closedSlices = (slices: readonly Slice[], snap: MarketSnapshot): Slice[] =>
  slices.filter((s) => !venueTradable(s.venue, s.session, snap.sessions));

export const avoidedSlices = (slices: readonly Slice[], profile: Profile): Slice[] =>
  slices.filter(
    (s) => profile.avoidSessions.includes(s.session) || (s.venue === "perp" && !profile.allowPerp),
  );
