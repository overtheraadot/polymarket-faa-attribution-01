# polymarket-faa-attribution-01

Entry for make.fun's **polymarket-faa-attribution-01** ($250): forecast, minute
by minute and 4 hours ahead, the Yes price of each of the 4 Polymarket FAA
outage attribution markets as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95).

## Method

`main.ts` (Node 22, standard library only, deterministic, no network) is a
per-market winsorised-volatility quantile forecaster:

- **Spread**: the standard deviation of one-minute price changes over three
  lookback windows (60 / 360 / 1440 minutes), each winsorised at its 99th
  percentile of |change| so a single jump cannot blow the spread up, blended
  0.45 / 0.35 / 0.20, then scaled by a level factor `sqrt(x(1-x)/0.25)` — a
  market near 0 or 1 moves less per minute than one near 0.5 — floored at
  0.00025 and capped at 0.02.
- **Empirical quantiles**: the 5/25/75/95 percentiles of the one-minute
  changes over the last 1440 minutes. Most minutes do not move at all, so
  these are much tighter than a normal band with the same spread, which is
  what the pinball loss rewards on quiet minutes.
- **Bands**: at horizon `h`, the half-width for level tau blends the two —
  `sqrt(h) * (0.5 * z_tau * sigma + 0.5 * empQ_tau)` — with the outer levels'
  normal part widened 1.35x (1.15x for the inner levels) for fat tails.
- **Median**: essentially the checkpoint price (persistence). A drift estimated
  from recent changes was tested and made the median error worse than
  persistence, so only a tiny pull toward the 360-minute median remains.

Forecasts are clamped to [0, 1], rounded to 6 decimals, and each row is forced
non-decreasing.

## Local grade (practice cases)

The kit ships no local scorer (the server grades), so the practice was scored
locally by reconstructing each case's actuals from the later cases' price
grids (p00–p04; p05 has no later case and is unscorable locally). Pooled
pinball loss over p00–p04:

| entry | pinball | median error | 90% coverage |
|---|---|---|---|
| house baseline (kit starter) | 0.392518 | 0.879497 | 0.9382 |
| **this entry** | **0.316961** | 0.879281 | 0.8412 |

Per case: p00 0.465170, p01 0.303310, p02 0.382106, p03 0.264901,
p04 0.208755. Two runs on the same cases are byte-identical (deterministic);
all six cases run in ~2.5 s total, far under the 8 s per-case cap.

Note: the practice is cut from Polymarket's "Next CEO of NVIDIA?" event, not
the FAA family, so the practice score is no guide to the final.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
