---
name: slipway
description: >
  Use this skill when the user has already decided to buy or sell a Bitget tokenized US
  stock (rToken R<TICKER>USDT, e.g. RNVDAUSDT) or stock perp (NVDAUSDT, TSLAUSDT, …) and
  wants to know HOW to execute it: which venue (rToken vs perp), which session (now,
  pre-market, the regular open, overnight, weekend), how to slice it, what it will cost
  and how uncertain that cost is, or wants order tickets for a sized order. Invoke it for
  phrasings like "I want $40k of NVDA before Thursday", "buy 200 TSLA, I'm patient",
  "what's the cheapest way to get into AAPL", "should I wait for the open", "no perps",
  "how deep is the rNVDA book overnight", "split it so I don't move the price", "why was
  my plan refused", and Chinese requests such as "周四前买四万美元英伟达", "怎么下单最便宜",
  "要不要等开盘", "不要合约", "分批买入". Do NOT use it to decide WHAT to trade, for
  crypto pairs, or to place live orders: Slipway issues dry-run tickets only; live
  placement is the plain Bitget skill's job (`bgc`), after the user confirms.
metadata:
  version: 0.1.0
  author: Slipway
  updated: 2026-10-06
  requires:
    bins: ["node"]
    node: ">=22"
  packages:
    mcp: "@slipway/mcp"
    sdk: "@slipway/sdk"
license: MIT
---

# Slipway Skill (execution desk for Bitget tokenized stocks)

Slipway prices every venue × session × slicing choice for one order against the live
Bitget book, gates the chosen plan in code, signs it, and turns it into dry-run order
tickets built by Bitget's own agent SDK (the exact `/api/v3/trade/place-order` body plus
the equivalent `bgc` command). Every figure it returns is computed by code from Bitget
data and carries its source; sources that were down are listed, never filled in.

**Rule Priority:** Safety (never ticket without ALLOW + user confirmation) > data honesty > speed.

## Step 1: Connect

Slipway is an MCP server (spec 2026-07-28, stateless; 2025-era clients are served too).

- **HTTP:** the Slipway deployment's `/api/mcp` endpoint (Streamable HTTP).
- **stdio (desktop clients):** the `slipway-mcp` binary from `@slipway/mcp`
  (`{ "command": "node", "args": ["packages/mcp/dist/bin.js"] }` from a built checkout).

No API keys are needed: market data is Bitget's public endpoints, tickets are dry runs.

## Step 2: When Slipway, when plain `bgc`

| The user wants… | Use |
|---|---|
| "How should I execute this order / what will it cost / which venue or session / slice it?" | **Slipway** (`price_options`) |
| Book depth, spread, funding, basis, session status for one stock | **Slipway** `market_state` (or `bgc market` for raw data) |
| When liquidity is best over the coming days | **Slipway** `liquidity_tide` |
| A checked, signed plan and its order tickets | **Slipway** `build_plan` → `issue_tickets` |
| To actually send an order, check balances, positions, transfers | **`bgc`** (Bitget skill), never Slipway |
| Crypto pairs, leverage settings, withdrawals | **`bgc`** |

## Step 3: The tool sequence

```
price_options ──> (user picks / says go) ──> build_plan ──> verdict?
                                                 ├─ ALLOW  → user confirms → issue_tickets → hand tickets to bgc if they want to send
                                                 └─ HOLD / REFUSE → explain the failed check + its fix → re-price
```

| Tool | Use for | Key arguments |
|---|---|---|
| `price_options` | **Always first** for an order. Prices every strategy family (immediate, sliced, passive, wait-for-session, perp-then-rotate, perp-hold), returns the best plan, the best per family, the Bitget-app TWAP baseline and a gate preview. | `symbol` (underlying, e.g. `NVDA`), `side`, exactly one of `notionalUsd` / `qty` (shares), optional `deadline` (as said: `"before thursday"`, `"by friday"`, `"in 2h"`, `"before the open"`, `"YYYY-MM-DD HH:mm"` New York), `venues` (`["rtoken"]` = no perps), `urgency` (`patient` / `normal` / `urgent`), `holdHorizonHours`, `profile` |
| `build_plan` | The user picked an option or said go. Re-prices on fresh data, runs the gate, signs the plan (Ed25519). | same order fields + `strategyId` (an id from `price_options`, or `"best"`, `"baseline"`, `"best:<family>"`) |
| `issue_tickets` | Only for a plan whose verdict is **ALLOW**, within its validity window (about a minute), **after the user confirms**. | `signedPlan` exactly as returned by `build_plan` |
| `market_state` | Live books, fees, funding, basis, sessions, events, data-integrity flags. | `symbol` |
| `liquidity_tide` | Depth and spread per session and venue over the coming days vs the live book. | `symbol` |
| `research` | Context: cash quote, perp 24h, technicals recomputed from Bitget's own bars, headlines; flags bad upstream data. | `symbol` |
| `explain` | "What does COST_CAP / gap risk / perp_then_rotate mean?" | `topic` |
| `track_record` | "How accurate are your cost forecasts?" | optional `symbol` |

Map the user's words: "$40k" → `notionalUsd: 40000`; "200 shares" → `qty: 200`; "no perps" →
`venues: ["rtoken"]`; "patient / no rush" → `urgency: "patient"`; "asap" → `"urgent"`; pass
deadlines in the user's own phrasing (Slipway resolves them in New York time). If the
symbol, side or size is missing, ask one short question instead of guessing.

## Confirm before ticket — two separate gates

1. **The desk's gate (code).** `issue_tickets` refuses unless the signature verifies with the
   desk's key, the content hash matches (nothing was edited), the verdict is ALLOW and the
   plan is fresh. Never edit a `signedPlan`; re-run `build_plan` instead.
2. **The user's go-ahead (you).** Even for an ALLOW plan, summarise it (venue, slices, expected
   cost and its p10–p90 band, deadline) and wait for an explicit yes before `issue_tickets`.

Tickets are **dry runs**: nothing reaches the exchange. If the user then wants to send them,
that is an ordinary write through the Bitget skill (`bgc order --action place …` without
`--dry-run`) and needs its own confirmation per the Bitget skill's write-safety rules.

## Reading a refusal

`build_plan` returns `verdict` plus one entry per check: `{ code, status: pass|hold|refuse, detail, fix }`.
Report the failed check in one line and offer its `fix` verbatim:

| Code | Means | Typical fix the desk returns |
|---|---|---|
| `COST_CAP` | Expected cost above the profile's cap | Largest size under the cap, or the best strategy that fits |
| `BOOK_EXHAUSTED` | A child needs more than the visible book | Largest size this shape absorbs, or more slices |
| `PARTICIPATION` | Children too large vs the venue's recorded traded flow | Spacing or child size that complies |
| `VENUE_CLOSED` | A child falls in a session where the venue does not trade | The next tradable session |
| `EVENT_WINDOW` (hold) | Earnings / ex-dividend / split (or opted-in macro) inside the window | A window that avoids it |
| `PRICE_INTEGRITY` (hold) | Perp index sources disagree or rToken/perp prices diverged | Wait for prices to re-converge |
| `DATA_STALE` | Plan or live book too old | Re-plan on fresh data |
| `PROFILE` | Uses perps / sessions the profile excludes | Re-plan under the profile |
| `SOURCE_MISSING` | A critical input (book, session state) is unavailable | Restore the feed and re-plan |

A refusal is the desk working, not an error: re-price with the fix applied (smaller size,
different strategy, later window) and present the new plan.

## Output contract

Every result is `{ data, slots, sources }`:

- `data` — the full computed object (options with cost bands, the signed plan, tickets, …).
- `slots` — named, unit-typed figures with their source (`{ value, unit, source }`); quote
  figures from here (or from the text summary), never compute or round your own.
- `sources` — each input with `status: live | cached | unavailable`. If something you rely on
  is `unavailable` (e.g. the earnings calendar, the liquidity atlas), say so and what it limits.

Costs are in **basis points of the arrival mid** (positive = cost to the trader); p10/p90 is
the expected cost ∓ a normal quantile × sd. Times are New York local unless marked UTC.

`build_plan` and `issue_tickets` link an MCP Apps view (`ui://slipway/plan`): a plan card with
the venue options and their cost bands, the verdict and fixes, the slices and the tickets.

## Output presentation

- Lead with the best plan: what it does, expected cost and its band, versus the TWAP baseline.
- Mention one real alternative family (e.g. wait for the regular open) and why it lost.
- State the gate verdict; for HOLD/REFUSE give the check and its fix.
- Keep it to a few lines; the plan card carries the detail.
