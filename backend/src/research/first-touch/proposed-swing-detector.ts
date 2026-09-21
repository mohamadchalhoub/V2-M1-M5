/**
 * research/first-touch/proposed-swing-detector — NOT an approved
 * level-selection method.
 *
 * This is a placeholder, OFF BY DEFAULT (nothing else in this module calls
 * it), that exists only so this module's own tests have a way to generate
 * sample `Level` objects to exercise the engine's plumbing — no-look-ahead
 * enforcement, first-touch scanning, outcome resolution, statistics. It
 * must never be presented as "the" level-selection method, never wired
 * into `scripts/first-touch-study.ts`, and never treated as validated
 * against real data (there is none yet). The loud, explicit name
 * (`PROPOSED_SWING_DETECTOR`, not e.g. `detectSwings`) is deliberate, to
 * make misuse obvious at any future call site.
 */
import { createLevel } from './engine';
import type { Candle, Level, LevelRole } from './types';

/** How many candles on each side must be less extreme for the middle one to count as a swing pivot. Arbitrary and unvalidated — see module doc above. */
const DEFAULT_SWING_WIDTH = 2;

export interface ProposedSwingDetectorOptions {
  swingWidth?: number;
  methodVersion?: string;
}

/**
 * UNAPPROVED — test fixture generator only. Finds simple swing highs/lows
 * in a chronological candle series (a candle whose high/low is the most
 * extreme among itself and `swingWidth` candles on each side) and turns
 * each into a `Level` via `createLevel`. `establishedAt` is set to the
 * close of the rightmost confirming candle, so the no-look-ahead invariant
 * holds by construction (and `createLevel` re-verifies it anyway).
 */
export function PROPOSED_SWING_DETECTOR(candles: Candle[], options: ProposedSwingDetectorOptions = {}): Level[] {
  const width = options.swingWidth ?? DEFAULT_SWING_WIDTH;
  const methodVersion = options.methodVersion ?? 'PROPOSED_SWING_DETECTOR_v0_UNAPPROVED';
  const sorted = [...candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const levels: Level[] = [];

  for (let i = width; i < sorted.length - width; i++) {
    const pivot = sorted[i];
    const confirmingCandles = sorted.slice(i - width, i + width + 1); // includes the pivot itself; the last entry is the rightmost confirming candle
    const lastConfirming = confirmingCandles[confirmingCandles.length - 1];

    const isHigh = confirmingCandles.every((c) => c.high <= pivot.high);
    const isLow = confirmingCandles.every((c) => c.low >= pivot.low);

    const makeLevel = (role: LevelRole, price: number): Level =>
      createLevel({
        id: `proposed-swing:${role}:${pivot.openTime.toISOString()}:${i}`,
        role,
        price,
        sourceCandles: confirmingCandles,
        establishedAt: lastConfirming.closeTime,
        methodVersion,
      });

    if (isHigh) levels.push(makeLevel('RESISTANCE', pivot.high));
    if (isLow) levels.push(makeLevel('SUPPORT', pivot.low));
  }

  return levels;
}
