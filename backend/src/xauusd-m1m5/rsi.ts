/**
 * MT5-compatible Wilder RSI, incremental, with intrabar projection.
 *
 * Timeframe-agnostic by construction: one instance of this state belongs to
 * exactly one timeframe, and §4/§10 require M1 and M5 to keep entirely
 * separate indicator state. Nothing here knows which timeframe it serves,
 * which is what makes sharing impossible by accident.
 *
 * Two things make this different from a textbook RSI helper, and both are
 * required by the spec:
 *
 * 1. **Closed-bar state is committed exactly once per bar.** The forming bar
 *    is NOT folded into the recursive average on every tick — doing so would
 *    treat each tick as its own RSI period and produce a value that drifts
 *    with tick density rather than with price (§10: "Ticks are not separate
 *    RSI periods"). `project()` recomputes the forming bar from the previous
 *    CLOSED state every time; `commitClosedBar()` advances the state once,
 *    when that timeframe's bar actually completes.
 *
 * 2. **MT5's exact zero-loss convention is reproduced**, including its
 *    behaviour on a perfectly flat price series. See `rsiFromAverages`.
 */
import { SPEC } from './spec';

export interface WilderRsiState {
  readonly period: number;
  /** Wilder-smoothed average gain over the closed bars folded in so far. */
  readonly avgGain: number;
  readonly avgLoss: number;
  /** Close of the most recently committed closed bar. */
  readonly lastClose: number;
  /** How many closed bars have been folded in since construction. */
  readonly closedBarCount: number;
  /** True once `period` price changes have been seeded — before this, no RSI exists at all. */
  readonly seeded: boolean;
  /** Closes buffered during seeding; empty once seeded. */
  readonly seedCloses: readonly number[];
}

export function createRsiState(period: number = SPEC.rsi.period): WilderRsiState {
  return { period, avgGain: 0, avgLoss: 0, lastClose: Number.NaN, closedBarCount: 0, seeded: false, seedCloses: [] };
}

/**
 * MT5's own zero-denominator convention, from `RSI.mq5`:
 *
 * ```
 * if(NegativeBuffer[i]!=0.0)
 *    RSIBuffer[i]=100.0-100.0/(1.0+PositiveBuffer[i]/NegativeBuffer[i]);
 * else
 *    RSIBuffer[i]=100.0;
 * ```
 *
 * Note what this means for a FLAT series: with no downward change at all,
 * average loss is 0 and MT5 reports **100**, even when average gain is also
 * 0 (no movement whatsoever). That is not a rounding artefact — it is what
 * the terminal displays, so reproducing it is what "MT5-compatible" means.
 *
 * Consequence, disclosed rather than filtered away: `period` consecutive
 * unchanged closes drive RSI to 100, which is >= the SELL crossing level of
 * 91, so a motionless feed could arm and fire a SELL. Adding a movement
 * filter to suppress that would be an unrequested entry filter, which §2
 * forbids, so the behaviour is left faithful and is instead defended against
 * by the observation layer's staleness and gap checks (a FROZEN feed is
 * rejected as not fresh) and surfaced on the dashboard. A flat but genuinely
 * live market still signals.
 */
export function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss !== 0) return 100 - 100 / (1 + avgGain / avgLoss);
  return 100;
}

/** RSI of the state as it stands — only meaningful once `seeded`. */
export function currentRsi(state: WilderRsiState): number | null {
  if (!state.seeded) return null;
  return rsiFromAverages(state.avgGain, state.avgLoss);
}

/**
 * Folds one CLOSED bar's close into the state. Call exactly once per
 * completed bar of this state's timeframe, in ascending time order.
 *
 * Seeding matches MT5: the first `period` price changes are averaged
 * arithmetically, and every change after that is Wilder-smoothed
 * (`avg = (avg * (period - 1) + value) / period`).
 */
export function commitClosedBar(state: WilderRsiState, close: number): WilderRsiState {
  if (!Number.isFinite(close)) throw new Error(`commitClosedBar: close must be finite, got ${close}`);

  if (!state.seeded) {
    const seedCloses = [...state.seedCloses, close];
    // `period` changes require `period + 1` closes.
    if (seedCloses.length <= state.period) {
      return { ...state, seedCloses, lastClose: close, closedBarCount: state.closedBarCount + 1 };
    }
    let gainSum = 0;
    let lossSum = 0;
    for (let i = 1; i < seedCloses.length; i += 1) {
      const diff = seedCloses[i] - seedCloses[i - 1];
      if (diff > 0) gainSum += diff;
      else lossSum += -diff;
    }
    return {
      period: state.period,
      avgGain: gainSum / state.period,
      avgLoss: lossSum / state.period,
      lastClose: close,
      closedBarCount: state.closedBarCount + 1,
      seeded: true,
      seedCloses: [],
    };
  }

  const diff = close - state.lastClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? -diff : 0;
  return {
    period: state.period,
    avgGain: (state.avgGain * (state.period - 1) + gain) / state.period,
    avgLoss: (state.avgLoss * (state.period - 1) + loss) / state.period,
    lastClose: close,
    closedBarCount: state.closedBarCount + 1,
    seeded: true,
    seedCloses: [],
  };
}

/**
 * The RSI the terminal would currently display for the FORMING bar, given
 * that bar's current price — computed from the previous closed state WITHOUT
 * mutating it.
 *
 * This is the intrabar value the strategy reacts to (§3: "The qualifying
 * intrabar threshold crossing itself is the signal"). Because it always
 * derives from the same committed closed-bar state, replaying the same tick
 * twice yields the same number, and tick density has no effect on the result
 * — which is what makes duplicate and out-of-order observations harmless.
 */
export function projectRsi(state: WilderRsiState, formingPrice: number): number | null {
  if (!state.seeded || !Number.isFinite(formingPrice)) return null;
  const diff = formingPrice - state.lastClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? -diff : 0;
  const avgGain = (state.avgGain * (state.period - 1) + gain) / state.period;
  const avgLoss = (state.avgLoss * (state.period - 1) + loss) / state.period;
  return rsiFromAverages(avgGain, avgLoss);
}

/**
 * True once enough closed bars exist on THIS timeframe for a signal to be
 * emitted (§3.3, §10). Counted in this timeframe's own bars: M5 warm-up is
 * 250 M5 bars and is not satisfied by M1 making progress.
 */
export function isWarmedUp(state: WilderRsiState): boolean {
  return state.seeded && state.closedBarCount >= state.period + 1 + SPEC.rsi.warmupBars;
}

/** Convenience for verification and indicator initialization: RSI over a close series. */
export function rsiSeries(closes: readonly number[], period: number = SPEC.rsi.period): Array<number | null> {
  let state = createRsiState(period);
  return closes.map((c) => {
    state = commitClosedBar(state, c);
    return currentRsi(state);
  });
}
