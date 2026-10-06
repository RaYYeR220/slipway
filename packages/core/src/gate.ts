import { mid } from "./book.js";
import { avoidedSlices, eventConflicts, participationBreaches } from "./constraints.js";
import { type CostOptions, type PlannedSlice, priceSchedule, type Schedule } from "./cost.js";
import { nextSessionStart, sessionAt, transitions, venueTradable } from "./session.js";
import { median } from "./stats.js";
import type {
  CheckStatus,
  GateCheck,
  GateCode,
  GateResult,
  MarketSnapshot,
  Plan,
  Profile,
  Session,
  Slice,
  StrategyQuote,
  Venue,
  Verdict,
} from "./types.js";

export interface GateOptions {
  maxBookAgeMs: number;
  maxPlanAgeMs: number;
  maxIndexSpreadBps: number;
  maxBasisBps: number;
  priorHalfLifeSec?: number;
}

export const GATE_DEFAULTS: GateOptions = {
  maxBookAgeMs: 10_000,
  maxPlanAgeMs: 60_000,
  maxIndexSpreadBps: 25,
  maxBasisBps: 75,
};

export interface GateInput {
  plan: Plan;
  snapshot: MarketSnapshot;
  profile: Profile;
  now: number;
  candidates?: StrategyQuote[]; // planner output, used to suggest a cheaper strategy under the cap
  options?: Partial<GateOptions>;
}

const ORDER: GateCode[] = [
  "DATA_STALE",
  "VENUE_CLOSED",
  "BOOK_EXHAUSTED",
  "COST_CAP",
  "PARTICIPATION",
  "EVENT_WINDOW",
  "PRICE_INTEGRITY",
  "PROFILE",
  "DEADLINE",
  "SOURCE_MISSING",
];
const CRITICAL_SOURCE = /orderbook|session/;
const TRADABLE_SESSIONS: Session[] = ["pre_market", "regular", "after_hours", "overnight", "weekend"];

const bps = (x: number) => `${x.toFixed(1)} bps`;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

export function verdictOf(checks: readonly GateCheck[]): Verdict {
  if (checks.some((c) => c.status === "refuse")) return "refuse";
  if (checks.some((c) => c.status === "hold")) return "hold";
  return "allow";
}

// Rebuilds the priceable schedule from a plan's slices so the gate re-prices instead of trusting the plan.
export function scheduleFromSlices(plan: Plan): Schedule {
  const slices = plan.strategy.slices;
  const legs: Record<NonNullable<Slice["leg"]>, PlannedSlice[]> = {
    entry: [],
    rotate_out: [],
    rotate_in: [],
  };
  slices.forEach((s, i) => {
    if (s.conditional) return;
    const leg = s.leg ?? "entry";
    if (s.type === "limit") {
      const cross = slices
        .slice(i + 1)
        .find((c) => c.conditional && c.venue === s.venue && c.side === s.side && (c.leg ?? "entry") === leg);
      const restSec = cross ? (cross.t - s.t) / 1000 : 0;
      legs[leg].push({ t: s.t, venue: s.venue, side: s.side, qty: s.qty, mode: "passive", restSec });
      return;
    }
    legs[leg].push({ t: s.t, venue: s.venue, side: s.side, qty: s.qty, mode: "market" });
  });
  const schedule: Schedule = { parentQty: plan.strategy.qty, entry: legs.entry };
  if (legs.rotate_out.length || legs.rotate_in.length)
    schedule.rotation = { out: legs.rotate_out, in: legs.rotate_in };
  const hold = plan.intent.holdHorizonHours;
  if (plan.strategy.kind === "perp_hold" && hold !== undefined)
    schedule.perpHoldUntil = plan.createdAt + hold * 3_600_000;
  return schedule;
}

function scaled(schedule: Schedule, qty: number): Schedule {
  const f = qty / schedule.parentQty;
  const s = (xs: PlannedSlice[]) => xs.map((x) => ({ ...x, qty: x.qty * f }));
  const out: Schedule = { ...schedule, parentQty: qty, entry: s(schedule.entry) };
  if (schedule.rotation) out.rotation = { out: s(schedule.rotation.out), in: s(schedule.rotation.in) };
  return out;
}

// Largest parent size of the same schedule shape whose expected cost stays within the cap without exhausting
// the book; cost in bps is non-decreasing in size, so bisection applies. null = not even a sliver fits.
export function largestQtyUnderCap(
  schedule: Schedule,
  snap: MarketSnapshot,
  capBps: number,
  options: CostOptions,
): number | null {
  const fits = (q: number) => {
    const r = priceSchedule(scaled(schedule, q), snap, options);
    return r.ok && !r.estimate.exhausted && r.estimate.expectedBps <= capBps;
  };
  const Q = schedule.parentQty;
  if (fits(Q)) return Q;
  if (!fits(Q * 1e-6)) return null;
  let lo = Q * 1e-6;
  let hi = Q;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (fits(m)) lo = m;
    else hi = m;
  }
  return lo;
}

export function runGate(input: GateInput): GateResult {
  const { plan, snapshot: snap, profile, now } = input;
  const o = { ...GATE_DEFAULTS, ...input.options };
  const symbol = plan.intent.symbol;
  const costOptions: CostOptions = { fees: { ...snap.fees, ...profile.feeOverride } };
  if (o.priorHalfLifeSec !== undefined) costOptions.priorHalfLifeSec = o.priorHalfLifeSec;
  const schedule = scheduleFromSlices(plan);
  const priced = priceSchedule(schedule, snap, costOptions);
  const slices: Slice[] = priced.ok
    ? priced.estimate.slices
    : plan.strategy.slices.map((s) => ({ ...s, session: sessionAt(s.t, snap.holidays).session }));
  const venues = [...new Set(slices.map((s) => s.venue))].sort();
  const times = slices.map((s) => s.t);
  const startsAt = Math.min(...times);
  const endsAt = Math.max(...times);
  const checks = new Map<GateCode, GateCheck>();
  const put = (code: GateCode, status: CheckStatus, detail: string, fix?: string) =>
    checks.set(code, fix === undefined ? { code, status, detail } : { code, status, detail, fix });
  const notPriced = priced.ok ? "" : `not evaluable: ${priced.reason}`;

  // SOURCE_MISSING
  {
    const missing: string[] = [];
    for (const v of venues) if (!snap.books[v]) missing.push(`no live ${v} book`);
    for (const s of snap.sources) {
      if (s.status === "unavailable" && CRITICAL_SOURCE.test(s.id))
        missing.push(`${s.id} unavailable since ${s.since ?? "unknown"}`);
    }
    if (snap.sessions.symbol !== symbol)
      missing.push(`session info is for ${snap.sessions.symbol}, not ${symbol}`);
    if (!priced.ok) missing.push(`cannot price the plan: ${priced.reason}`);
    if (missing.length)
      put("SOURCE_MISSING", "refuse", missing.join("; "), "restore the missing feed and re-plan");
    else put("SOURCE_MISSING", "pass", "books, session state and pricing inputs present");
  }

  // DATA_STALE
  {
    const problems: string[] = [];
    let fix: string | undefined;
    const planAge = now - plan.createdAt;
    if (planAge > o.maxPlanAgeMs) {
      problems.push(`plan priced ${(planAge / 1000).toFixed(0)}s ago (max ${o.maxPlanAgeMs / 1000}s)`);
      fix = "re-plan on fresh data";
    }
    const spanEnd = transitions(now, now + 7 * 86_400_000, snap.holidays)[0]?.end ?? now;
    const nowVenues = new Set(slices.filter((s) => s.t < spanEnd).map((s) => s.venue));
    for (const v of [...nowVenues].sort()) {
      const book = snap.books[v];
      if (book && now - book.ts > o.maxBookAgeMs) {
        problems.push(
          `${v} book is ${((now - book.ts) / 1000).toFixed(1)}s old (max ${o.maxBookAgeMs / 1000}s)`,
        );
        fix ??= `refresh the ${v} book`;
      }
    }
    if (problems.length) put("DATA_STALE", "refuse", problems.join("; "), fix);
    else
      put(
        "DATA_STALE",
        "pass",
        `plan age ${(planAge / 1000).toFixed(1)}s; live books within ${o.maxBookAgeMs / 1000}s`,
      );
  }

  // VENUE_CLOSED
  {
    const closed = slices.filter((s) => !venueTradable(s.venue, s.session, snap.sessions));
    const first = closed[0];
    if (first) {
      const next = TRADABLE_SESSIONS.filter((s) => venueTradable(first.venue, s, snap.sessions))
        .map((s) => ({ s, at: nextSessionStart(first.t, s, snap.holidays) }))
        .sort((a, b) => a.at - b.at)[0];
      put(
        "VENUE_CLOSED",
        "refuse",
        `${closed.length} slice(s) on ${first.venue} during ${first.session}, when it does not trade`,
        next
          ? `earliest ${first.venue} session: ${next.s} at ${sessionAt(next.at, snap.holidays).nyLocal} NY`
          : undefined,
      );
    } else
      put(
        "VENUE_CLOSED",
        "pass",
        `every slice falls in a tradable session (${[...new Set(slices.map((s) => `${s.venue}/${s.session}`))].join(", ")})`,
      );
  }

  // BOOK_EXHAUSTED + COST_CAP
  if (!priced.ok) {
    put("BOOK_EXHAUSTED", "refuse", notPriced);
    put("COST_CAP", "refuse", notPriced);
  } else {
    const e = priced.estimate;
    const refBook = snap.books[(slices[0] as Slice).venue];
    const midNow = refBook ? mid(refBook) : Number.NaN; // pricing succeeded, so the venue's live book exists
    if (e.exhausted) {
      const q = largestQtyUnderCap(schedule, snap, Number.POSITIVE_INFINITY, costOptions);
      put(
        "BOOK_EXHAUSTED",
        "refuse",
        "at least one slice needs more than the visible book",
        q
          ? `largest size the visible book absorbs with this shape: ${q.toFixed(4)} ${symbol} (~${usd(q * midNow)})`
          : "split into more slices",
      );
    } else put("BOOK_EXHAUSTED", "pass", "every slice fits inside the visible book");

    if (e.expectedBps > profile.costCapBps) {
      const fixes: string[] = [];
      const q = largestQtyUnderCap(schedule, snap, profile.costCapBps, costOptions);
      if (q === null) {
        const floor = priceSchedule(scaled(schedule, schedule.parentQty * 1e-6), snap, costOptions);
        const floorBps = floor.ok ? bps(floor.estimate.expectedBps) : "unknown";
        fixes.push(
          `no size of this strategy fits under ${bps(profile.costCapBps)} (fees + spread alone ${floorBps})`,
        );
      } else
        fixes.push(
          `reduce to ${q.toFixed(4)} ${symbol} (~${usd(q * midNow)}) to stay within ${bps(profile.costCapBps)}`,
        );
      const alt = (input.candidates ?? [])
        .filter(
          (c) => c.feasible !== false && c.id !== plan.strategy.id && c.expectedBps <= profile.costCapBps,
        )
        .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1))[0];
      if (alt) fixes.push(`or switch to ${alt.id} (${bps(alt.expectedBps)} expected)`);
      put(
        "COST_CAP",
        "refuse",
        `expected ${bps(e.expectedBps)} > cap ${bps(profile.costCapBps)}`,
        fixes.join("; "),
      );
    } else put("COST_CAP", "pass", `expected ${bps(e.expectedBps)} ≤ cap ${bps(profile.costCapBps)}`);
  }

  // PARTICIPATION
  {
    const { breaches, waived, evaluated } = participationBreaches(slices, snap, profile);
    const worst = [...breaches].sort((a, b) => b.notionalUsd / b.capUsd - a.notionalUsd / a.capUsd)[0];
    if (worst) {
      const flowPerMin = worst.capUsd / profile.maxParticipation / (worst.intervalSec / 60);
      const needSec = Math.ceil((worst.notionalUsd / (profile.maxParticipation * flowPerMin)) * 60);
      put(
        "PARTICIPATION",
        "refuse",
        `${breaches.length} child(ren) above ${(profile.maxParticipation * 100).toFixed(1)}% of recorded flow (worst ${usd(worst.notionalUsd)} vs cap ${usd(worst.capUsd)} on ${worst.slice.venue}/${worst.slice.session})`,
        `space children ≥ ${needSec}s apart or make them ≤ ${usd(worst.capUsd)} (smaller)`,
      );
    } else if (evaluated === 0) {
      put("PARTICIPATION", "pass", "single child order; the participation cap applies to sliced schedules");
    } else {
      const note = waived.length ? `; cap waived on ${waived.join(", ")} (no recorded prints)` : "";
      put(
        "PARTICIPATION",
        "pass",
        `children within ${(profile.maxParticipation * 100).toFixed(1)}% of recorded flow${note}`,
      );
    }
  }

  // EVENT_WINDOW
  {
    const hits = eventConflicts(startsAt, endsAt, snap.events, symbol, profile);
    const e = hits[0];
    if (e) {
      const lo = sessionAt(e.ts - e.windowSec * 1000, snap.holidays).nyLocal;
      const hi = sessionAt(e.ts + e.windowSec * 1000, snap.holidays).nyLocal;
      put(
        "EVENT_WINDOW",
        "hold",
        `${e.kind} "${e.label}" (${e.source}) inside the execution window`,
        `finish before ${lo} NY or start after ${hi} NY`,
      );
    } else put("EVENT_WINDOW", "pass", `${snap.events.length} event(s) checked; none inside the window`);
  }

  // PRICE_INTEGRITY
  {
    const problems: string[] = [];
    const notes: string[] = [];
    const comps = snap.indexComponents ?? [];
    if (comps.length >= 2) {
      const prices = comps.map((c) => c.price);
      const spread = ((Math.max(...prices) - Math.min(...prices)) / median(prices)) * 1e4;
      (spread > o.maxIndexSpreadBps ? problems : notes).push(`perp index components span ${bps(spread)}`);
    } else notes.push("index components not supplied");
    const r = snap.books.rtoken;
    const p = snap.books.perp;
    const nowSession = sessionAt(now, snap.holidays).session;
    const live = (v: Venue) => {
      const b = snap.books[v];
      return b !== undefined && now - b.ts <= o.maxBookAgeMs && venueTradable(v, nowSession, snap.sessions);
    };
    if (r && p && live("rtoken") && live("perp")) {
      const basis = (mid(r) / mid(p) - 1) * 1e4;
      (Math.abs(basis) > o.maxBasisBps ? problems : notes).push(`rToken/perp basis ${bps(basis)}`);
    }
    if (problems.length)
      put("PRICE_INTEGRITY", "hold", problems.join("; "), "wait for prices to re-converge");
    else put("PRICE_INTEGRITY", "pass", notes.join("; "));
  }

  // PROFILE
  {
    const problems: string[] = [];
    const perp = slices.some((s) => s.venue === "perp");
    if (perp && !profile.allowPerp) problems.push("perp legs but the profile does not allow perps");
    if (perp && profile.maxLeverage < 1)
      problems.push(`perp legs are planned at 1x but max leverage is ${profile.maxLeverage}`);
    const avoided = avoidedSlices(slices, profile).filter((s) => profile.avoidSessions.includes(s.session));
    if (avoided.length)
      problems.push(
        `${avoided.length} slice(s) in avoided session(s) ${[...new Set(avoided.map((s) => s.session))].join(", ")}`,
      );
    if (problems.length) put("PROFILE", "refuse", problems.join("; "), "re-plan under the current profile");
    else put("PROFILE", "pass", `consistent with profile "${profile.name}"`);
  }

  // DEADLINE
  {
    const deadline = plan.intent.deadline;
    const last = slices.reduce((m, s) => Math.max(m, s.t), Number.NEGATIVE_INFINITY);
    if (deadline !== undefined && last > deadline) {
      const minutes = Math.ceil((last - deadline) / 60_000);
      const inTime = (input.candidates ?? [])
        .filter((c) => c.feasible !== false && c.slices.every((s) => s.t <= deadline))
        .sort((a, b) => a.score - b.score)[0];
      put(
        "DEADLINE",
        "refuse",
        `last slice lands ${minutes} min after the deadline`,
        inTime ? `use ${inTime.id} (${bps(inTime.expectedBps)}), which finishes in time` : "move the deadline or trade faster",
      );
    } else {
      put("DEADLINE", "pass", deadline === undefined ? "no deadline set" : "every slice lands before the deadline");
    }
  }

  const ordered = ORDER.map((code) => checks.get(code) as GateCheck);
  return { verdict: verdictOf(ordered), checks: ordered };
}
