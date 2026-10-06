# Test fixtures — real recorded Bitget market data

Every file here is trimmed from the Slipway tape recorder (Bitget public WS `books15` + `trade` + `ticker`,
REST `spot/market/orderbook?limit=150` and `mix/market/merge-depth?limit=max`, keyless). Nothing is synthesised.
Times are UTC; the NY session is derived with `America/New_York` (EDT, UTC−4, on these dates).

| File | Instruments | Window (UTC) | NY session | Contents |
|---|---|---|---|---|
| `nvda-books.json` | RNVDAUSDT (spot rToken), NVDAUSDT (USDT-M perp) | 2026-10-05 23:30 and 2026-10-06 02:30 | after_hours (Mon 19:30) and overnight (Mon 22:30) | per instrument: nearest `books15` snapshot, nearest REST full-depth snapshot (raw payload shape: strings for spot, numbers for perp), perp ticker (funding, next funding, mark, index) |
| `thin-books.json` | RHOODUSDT, HOODUSDT, RCRCLUSDT | 2026-10-06 02:30 | overnight | same layout; RHOOD is the thinnest rToken book in the universe (≈$4k within ±25 bps per side) |
| `mu-perp-sequence.json` | MUUSDT perp | 2026-10-06 01:45:20 → 01:50:23 (300 consecutive snapshots) | overnight | `books15` (≤1/s, on change) + every public trade in the window. Chosen as the densest 5-minute window of trade-coincident depth drops in that hour (18 events) for the resilience estimator |
| `nvda-perp-sequence.json` | NVDAUSDT perp | 2026-10-06 02:30:01 → 02:36:33 (300 snapshots) | overnight | `books15` + trades + the 7 REST depth snapshots taken inside the window |
| `reference.json` | RNVDAUSDT, RHOODUSDT, NVDAUSDT, HOODUSDT | fetched 2026-10-06 ~05:10 | n/a | raw `spot/public/symbols` (fees 0.10%/0.10%), `mix/market/contracts` (0.02%/0.06%, `fundInterval` 8, `maxMarketOrderQty`), Reality `stock-info` (sessions, `weekendTradable`), and the recorded Reality `states` payload (labels EST during EDT) |
| `rnvda-sequence.json` | RNVDAUSDT spot | 2026-10-06 02:00:01 → 02:29:00 (124 snapshots) | overnight | `books15` (the rToken book changes ~every 14 s) + 29 REST depth snapshots; zero public trades printed in the window |

Sequence files store levels as `[px, sz]` numbers instead of the WS strings to stay under 200 KB; values are unchanged.
Trades keep Bitget's taker `side` (`buy` lifts asks, `sell` hits bids). The recorder's subscribe-time trade backfill
(prints older than 60 s at receipt) is excluded.

`reference.json` also carries one **derived** number, `derived.basisSigmaBpsPerSqrtHour.NVDA = 4.78`: the standard
deviation of 1-hour changes in log(rNVDA mid / NVDA perp mid) over the six recorded hours (method in the file).
Scaling the 1-minute changes by √60 would give 16 bps — the basis mean-reverts, so the direct hourly figure is used.
