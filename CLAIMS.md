# Claims ledger

Every public statement about Slipway, tagged by how it can be checked.

- **REPRODUCIBLE**: anyone can recompute it from public data and this repository.
- **VERIFIED-LIVE**: observed against a live system during the build; re-checkable while that system is up.
- **MODELED**: produced by a model whose assumptions are stated; not observed directly.
- **NOT-CLAIMED**: explicitly outside what Slipway claims.

## Execution and cost

| Claim | Tier | Evidence |
|---|---|---|
| Every candidate is priced level by level against Bitget's live public books for the rToken and the stock perp | VERIFIED-LIVE | `packages/bitget/src/rest.ts`, `/api/market/:symbol` |
| Taker and maker fees come from Bitget's symbol and contract endpoints, not assumptions | VERIFIED-LIVE | `packages/bitget/src/parse.ts` |
| Sessions use real New York time with DST; Bitget's own Reality label says EST during EDT and is not trusted | REPRODUCIBLE | `packages/core/src/session.ts`, atlas flags |
| Cost of later slices includes transient impact with a measured book-refill half-life | MODELED | `packages/core/src/cost.ts`, `resilience.ts` |
| Price risk, gap risk across closed sessions and rToken/perp basis risk are priced as variance | MODELED | `packages/core/src/cost.ts` |
| Passive (maker) fills follow a Poisson trade-arrival model | MODELED | `packages/core/src/cost.ts` |
| The gate refuses in code and every refusal carries a fix | REPRODUCIBLE | `packages/core/src/gate.ts`, `packages/core/test/gate.test.ts` |
| Tickets are only issued for an untampered, fresh, ALLOW plan | REPRODUCIBLE | `packages/core/src/sign.ts` `assertTicketable`, tamper tests |
| Ticket payloads are what Bitget's official agent SDK sends, and its MockServer accepts them | REPRODUCIBLE | `packages/bitget/test/ticket.test.ts` |

## Track record

| Claim | Tier | Evidence |
|---|---|---|
| Forecasts are registered before the tape that grades them prints, under a fixed protocol | REPRODUCIBLE | `eval/protocol.json`, `ledger/eval/` timestamps, hash chain |
| Chosen plan versus immediate order and 60-second TWAP: win rates and mean differences with 95% CIs | REPRODUCIBLE | `derived/track-record.json`, label REPRODUCIBLE (shadow fill on the recorded book) |
| The same comparison with own-impact carry-over | MODELED | label MODELED |
| The same comparison assuming no book refill | MODELED | label BOUND |
| Source ablation results, including sources with no effect and one with a negative effect | REPRODUCIBLE | saved snapshots under `eval/snapshots/`, re-planned by the grader |
| Ledger Merkle roots are anchored on Arbitrum One every 30 minutes in contiguous windows from the protocol's genesis | REPRODUCIBLE | contract `0x33c8b0CDcb9712196184FD48F54Eb4Eef6C82d5F` (Sourcify exact match), `anchors/<i>.json`, `pnpm verify` |
| A given forecast was committed before its outcome | REPRODUCIBLE only for forecasts whose outcome time is after their anchor's block time; the first anchor (2026-10-07) covered every forecast since genesis at once, so forecasts graded before it are ledger-timestamped only | track record `anchoring` counts |

## Language interface

| Claim | Tier | Evidence |
|---|---|---|
| The model cannot put a numeral of any script in front of the trader | REPRODUCIBLE | `packages/agent/src/slots.ts`, `packages/agent/test/slots.test.ts` |
| Pre-registered LUI evaluation, 20 conversations: first run scored 0.858 | VERIFIED-LIVE | `packages/agent/eval/lui-results-run1.json` |
| A second run scored 0.994 after prompt changes on the same cases | VERIFIED-LIVE, not held out | `packages/agent/eval/lui-results.json` |
| Detection of numbers written as words | NOT-CLAIMED beyond English, Russian and Chinese word lists | `slots.ts` |

## Not claimed

- Real order execution, fills or PnL. Tickets are dry runs.
- Weekend order-book behaviour (not recorded before the deadline; weekend statements rest on candles).
- That rToken liquidity equals the public tape: routed fills do not print publicly.
- That the forecast band is calibrated for immediate orders: measured p10–p90 coverage is below 80% there.
- Investment advice.
