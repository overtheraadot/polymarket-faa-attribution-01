// polymarket-faa-attribution-01 entry (Node 22, standard library only).
//
// Per-market winsorised-volatility quantile forecaster.
//
// Idea: prediction-market Yes prices mostly sit still for minutes at a time
// and then jump. A fixed spread (like the house baseline's 0.0025) is far too
// wide for the quiet markets that dominate the family and too narrow for the
// jumpy ones, so the spread is estimated per market from its own recent
// one-minute moves, and the median carries a small, heavily shrunk drift.
//
// For each market, with x its price at the checkpoint:
//   * sigma: the standard deviation of its one-minute price changes, computed
//     over three lookback windows (60 / 360 / 1440 minutes), each winsorised
//     at its 99th percentile of |change| so one jump cannot blow the spread
//     up, then blended 0.45 / 0.35 / 0.20. It is scaled by a level factor
//     sqrt(x(1-x)/0.25) (a market near 0 or 1 cannot move as far in a minute
//     as one near 0.5), floored and capped.
//   * empirical quantiles: the 5/25/75/95 percentiles of the same one-minute
//     changes over the last 1440 minutes. Because most minutes do not move at
//     all, these are usually much tighter than a normal band with the same
//     spread, which is exactly what the pinball loss rewards on quiet minutes.
//   * the half-width at horizon h for level tau blends the two:
//       w_tau(h) = sqrt(h) * (0.5 * z_tau * sigma + 0.5 * empQ_tau)
//     with the outer levels' normal part widened (fatter tails than a normal
//     allows for the occasional jump).
//   * the median at horizon h is x plus a drift: the mean one-minute change
//     over the last 120 minutes, shrunk by 0.3, plus a small pull toward the
//     market's 360-minute median, the total displacement capped at 0.04.
//     Everything is clamped to [0, 1], rounded to 6 decimals, and each row is
//     forced non-decreasing.
//
// Deterministic: no randomness, no network, no clock. Two runs on the same
// case write byte-identical output.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** Extra widening of the normal part for the outer / inner levels (fat tails). */
const TAIL_MULT = [1.35, 1.15, 1, 1.15, 1.35];

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0, 1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Sorted-copy quantile with linear interpolation (deterministic). */
function quantileOf(sorted: number[], tau: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] as number;
  const pos = tau * (n - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  const a = sorted[lo] as number;
  const b = sorted[Math.min(lo + 1, n - 1)] as number;
  return a + frac * (b - a);
}

/** Standard deviation of `diffs` after winsorising each value to +/- cap. */
function winsorisedStd(diffs: number[], cap: number): number {
  if (diffs.length < 2) return 0;
  let mean = 0;
  for (const d of diffs) mean += clamp(d, -cap, cap);
  mean /= diffs.length;
  let ss = 0;
  for (const d of diffs) {
    const w = clamp(d, -cap, cap) - mean;
    ss += w * w;
  }
  return Math.sqrt(ss / diffs.length);
}

/** Median of a sorted array. */
function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1
    ? (sorted[(n - 1) / 2] as number)
    : (((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2);
}

/** The forecast of one market: horizon rows of the five quantiles. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  const p = m.prices;
  if (p.length === 0) throw new Error(`market ${m.id} has no prices`);
  const x = p[p.length - 1] as number;

  // One-minute changes, most recent first in index order (oldest to newest).
  const n = p.length - 1;
  const diffs: number[] = new Array<number>(Math.max(n, 0));
  for (let i = 0; i < n; i++) diffs[i] = (p[i + 1] as number) - (p[i] as number);

  // Winsorised volatility per lookback window, blended short -> long.
  const windows: Array<[number, number]> = [
    [60, 0.45],
    [360, 0.35],
    [1440, 0.2],
  ];
  let sigma = 0;
  for (const [w, weight] of windows) {
    const seg = diffs.slice(Math.max(0, diffs.length - w));
    if (seg.length < 2) continue;
    const absSorted = seg.map((d) => Math.abs(d)).sort((a, b) => a - b);
    const cap = Math.max(quantileOf(absSorted, 0.99), 1e-6);
    sigma += weight * winsorisedStd(seg, cap);
  }
  // Level factor: a price near 0 or 1 moves less per minute than one near 0.5.
  const level = clamp(Math.sqrt(Math.max(x * (1 - x), 0.004) / 0.25), 0.25, 1);
  sigma = clamp(sigma * level, 0.00025, 0.02);

  // Empirical quantiles of the one-minute changes over the last 1440 minutes.
  const empSeg = diffs.slice(Math.max(0, diffs.length - 1440));
  const empSorted = [...empSeg].sort((a, b) => a - b);
  const empQ = QUANTILES.map((tau) => quantileOf(empSorted, tau));

  // Drift for the median: v1 used a shrunk mean change over the last 120
  // minutes plus a pull toward the 360-minute median, but on the practice
  // cases that moved the median away from the checkpoint price and made the
  // median error worse than plain persistence (0.95 vs the baseline's 0.88).
  // Prediction-market prices jump and then sit: the checkpoint price is the
  // best median. Keep only a very small pull toward the 360-minute median.
  const last360 = p.slice(Math.max(0, p.length - 360)).slice().sort((a, b) => a - b);
  const med360 = medianOf(last360);
  const driftPerMin = clamp(0.0001 * (med360 - x), -0.00005, 0.00005);

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const rootH = Math.sqrt(h);
    const med = clamp(x + driftPerMin * h, x - 0.04, x + 0.04);
    const row: number[] = [];
    for (let j = 0; j < QUANTILES.length; j++) {
      const z = Z[j] as number;
      const half =
        z === 0
          ? 0
          : rootH * (0.5 * z * (TAIL_MULT[j] as number) * sigma + 0.5 * (empQ[j] as number));
      row.push(price6(med + half));
    }
    // Enforce non-decreasing quantiles (rounding / blending can invert a row).
    for (let j = 1; j < row.length; j++) {
      if ((row[j] as number) < (row[j - 1] as number)) row[j] = row[j - 1] as number;
    }
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
