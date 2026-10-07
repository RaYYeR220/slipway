# Review Slipway in five minutes

No account, key or install is needed for steps 1–4.

## 1. Run one research task, question to ticket (2 min)

Open **https://slipway-desk.vercel.app/desk** and send:

> I want $40k of NVDA before Thursday, no perps, I'm patient

Watch for:

- the **plan canvas**: every venue path priced with an expected cost and a p10–p90 band, the efficient frontier of all candidates, and the chosen slices drawn on the week's liquidity;
- **sourced numbers**: hover any figure in the reply to see which tool and data source produced it;
- the **gate**: ten checks with their status, then a signed plan with a 60-second window;
- **"Issue dry-run tickets"**: the exact Bitget UTA v3 request and the `bgc … --dry-run` command for each slice.

Then make it refuse: set the cost cap in the profile to 3 bp and ask again. The gate refuses, says why, and offers the largest size that fits. No ticket can be issued for that plan.

## 2. Check the track record (1 min)

Open **https://slipway-desk.vercel.app/track-record**.

- Forecasts registered before their tape printed, and how many were graded or left ungraded (with reasons).
- Head-to-head against an immediate order and a 60-second TWAP, with bootstrap confidence intervals.
- **Where Slipway loses**, listed explicitly.
- The source ablation: what each Bitget data source changes, including one that made choices worse.

## 3. Re-check it yourself (1 min)

```bash
git clone https://github.com/RaYYeR220/slipway && cd slipway
pnpm install && pnpm -r build
pnpm verify
```

This downloads the public ledger, checks both hash chains and every plan signature, re-grades a random sample of forecasts from the public tape, and confirms that a forged forecast, Merkle leaf and signed plan are all rejected.

It also recomputes each Merkle root and checks it against the on-chain anchor: [`ForecastAnchor` on Arbitrum One](https://arbiscan.io/address/0x33c8b0CDcb9712196184FD48F54Eb4Eef6C82d5F), source verified on [Sourcify](https://repo.sourcify.dev/42161/0x33c8b0CDcb9712196184FD48F54Eb4Eef6C82d5F).

Public data: `https://storage.googleapis.com/slipway-tape-c48c75/` (`derived/track-record.json`, `derived/atlas.json`, `ledger/`, `eval/`, `grades/`, `anchors/`, `tape/raw/`).

## 4. Use it from your own agent (1 min)

Add the MCP server `https://slipway-desk.vercel.app/api/mcp` to any MCP client and call `price_options` with `{"symbol":"NVDA","side":"buy","notionalUsd":40000}`. Or read [`skills/slipway/SKILL.md`](skills/slipway/SKILL.md), written in Bitget's skill format.

## Where to look in the code

| Claim | Code |
|---|---|
| Cost model, planner, gate, signing | `packages/core/src/{cost,planner,gate,sign}.ts` |
| Model cannot write numbers | `packages/agent/src/slots.ts` |
| Tickets via Bitget's agent SDK, checked against its MockServer | `packages/bitget/src/ticket.ts`, `packages/bitget/test/ticket.test.ts` |
| Pre-registered protocol | `eval/protocol.json` |
| Grader, ablation, verify | `packages/tape/src/` |
| Ledger anchor contract | `contracts/src/ForecastAnchor.sol` |

What is real, modelled or not claimed: [CLAIMS.md](CLAIMS.md).
