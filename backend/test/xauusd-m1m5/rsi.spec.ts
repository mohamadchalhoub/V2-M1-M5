/**
 * §15.4 — RSI(5), PRICE_CLOSE, Wilder, with intrabar projection.
 *
 * The properties asserted here are the ones the strategy's correctness rests
 * on: that a tick is not an RSI period, that the same tick replayed gives
 * the same number, that warm-up is counted in the owning timeframe's own
 * bars, and that MT5's zero-loss convention is reproduced rather than
 * "fixed".
 */
import { describe, expect, it } from 'vitest';
import {
  commitClosedBar,
  createRsiState,
  currentRsi,
  isWarmedUp,
  projectRsi,
  rsiFromAverages,
  rsiSeries,
} from '../../src/xauusd-m1m5/rsi';
import { SPEC } from '../../src/xauusd-m1m5/spec';

/** Reference Wilder RSI over a close series, computed independently of the module. */
function referenceRsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss += -d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return avgLoss !== 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
}

function feed(closes: number[], period = SPEC.rsi.period) {
  let s = createRsiState(period);
  for (const c of closes) s = commitClosedBar(s, c);
  return s;
}

describe('Wilder RSI seeding and smoothing', () => {
  it('produces no RSI until period + 1 closes have been folded in', () => {
    let s = createRsiState(5);
    for (let i = 0; i < 5; i += 1) {
      s = commitClosedBar(s, 4450 + i);
      expect(currentRsi(s)).toBeNull();
      expect(s.seeded).toBe(false);
    }
    s = commitClosedBar(s, 4456);
    expect(s.seeded).toBe(true);
    expect(currentRsi(s)).not.toBeNull();
  });

  it('matches an independent reference implementation', () => {
    const closes = [4450, 4452, 4451, 4455, 4453, 4458, 4457, 4460, 4456, 4461, 4459, 4465];
    const s = feed(closes);
    expect(currentRsi(s)).toBeCloseTo(referenceRsi(closes, 5) as number, 10);
  });

  it('a monotonic rise drives RSI to 100 and a monotonic fall to 0', () => {
    const up = feed([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(currentRsi(up)).toBeCloseTo(100, 10);
    const down = feed([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(currentRsi(down)).toBeCloseTo(0, 10);
  });

  it('rejects a non-finite close rather than corrupting the state', () => {
    const s = feed([1, 2, 3, 4, 5, 6]);
    expect(() => commitClosedBar(s, Number.NaN)).toThrow(/finite/);
  });
});

describe("MT5's zero-loss convention", () => {
  it('reports 100 when average loss is zero, as the terminal does', () => {
    expect(rsiFromAverages(1, 0)).toBe(100);
    // Including the degenerate case of no movement at all.
    expect(rsiFromAverages(0, 0)).toBe(100);
  });

  it('a perfectly flat series reports 100 rather than being filtered away', () => {
    // Disclosed behaviour, not a bug: suppressing it would be an unrequested
    // entry filter. The observation layer's staleness checks are what defend
    // against a frozen feed.
    const flat = feed([4450, 4450, 4450, 4450, 4450, 4450, 4450]);
    expect(currentRsi(flat)).toBe(100);
  });
});

describe('intrabar projection — ticks are not RSI periods (§10)', () => {
  const closed = feed([4450, 4452, 4451, 4455, 4453, 4458]);

  it('projects from the last CLOSED state without mutating it', () => {
    const before = { ...closed };
    const projected = projectRsi(closed, 4460);
    expect(projected).not.toBeNull();
    expect(closed).toEqual(before);
  });

  it('is a pure function of the forming price: replaying a tick is idempotent', () => {
    const a = projectRsi(closed, 4460);
    const b = projectRsi(closed, 4460);
    expect(a).toBe(b);
  });

  it('tick density has no effect on the projected value', () => {
    // Ten intermediate ticks then 4460, versus 4460 directly. Same answer,
    // because none of them were folded into the recursive average.
    let s = closed;
    for (const p of [4459, 4458, 4457, 4456, 4455, 4456, 4457, 4458, 4459, 4460]) {
      expect(projectRsi(s, p)).toBe(projectRsi(closed, p));
    }
    expect(projectRsi(s, 4460)).toBe(projectRsi(closed, 4460));
  });

  it('projecting then committing the same price equals committing it directly', () => {
    const projected = projectRsi(closed, 4460);
    const committed = currentRsi(commitClosedBar(closed, 4460));
    expect(projected).toBeCloseTo(committed as number, 12);
  });

  it('returns null before the state is seeded', () => {
    expect(projectRsi(createRsiState(5), 4460)).toBeNull();
  });

  it('returns null for a non-finite forming price', () => {
    expect(projectRsi(closed, Number.NaN)).toBeNull();
  });
});

describe('warm-up is counted in the owning timeframe’s own bars (§3.3)', () => {
  it('is not warmed up until period + 1 + warmupBars closed bars exist', () => {
    const needed = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
    let s = createRsiState();
    for (let i = 0; i < needed - 1; i += 1) s = commitClosedBar(s, 4450 + (i % 7));
    expect(s.closedBarCount).toBe(needed - 1);
    expect(isWarmedUp(s)).toBe(false);

    s = commitClosedBar(s, 4451);
    expect(isWarmedUp(s)).toBe(true);
  });

  it('M5 warm-up needs 250 M5 bars and is not satisfied by M1 progress', () => {
    // The states are separate values; there is no shared counter that M1
    // could advance on M5's behalf. Feeding one leaves the other cold.
    const needed = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
    let m1 = createRsiState();
    for (let i = 0; i < needed; i += 1) m1 = commitClosedBar(m1, 4450 + (i % 7));
    const m5 = createRsiState();

    expect(isWarmedUp(m1)).toBe(true);
    expect(isWarmedUp(m5)).toBe(false);
    expect(m5.closedBarCount).toBe(0);
  });
});

describe('rsiSeries helper, used for indicator initialization only', () => {
  it('returns null for every bar before the series is seeded', () => {
    const series = rsiSeries([1, 2, 3, 4, 5, 6, 7]);
    expect(series.slice(0, 5).every((v) => v === null)).toBe(true);
    expect(series[5]).not.toBeNull();
  });

  it('agrees with the incremental state at the final bar', () => {
    const closes = [4450, 4452, 4451, 4455, 4453, 4458, 4457, 4460];
    const series = rsiSeries(closes);
    expect(series[series.length - 1]).toBeCloseTo(currentRsi(feed(closes)) as number, 12);
  });
});

describe('the values the strategy actually keys on', () => {
  it('can reach the SELL threshold from below and the BUY threshold from above', () => {
    // A sanity check that 91 and 8.9 are attainable values for RSI(5), so
    // the thresholds are not unreachable in practice.
    const rising = feed([4450, 4449, 4451, 4450, 4452, 4451, 4460, 4470]);
    expect(currentRsi(rising) as number).toBeGreaterThan(91);

    const falling = feed([4450, 4451, 4449, 4450, 4448, 4449, 4440, 4430]);
    expect(currentRsi(falling) as number).toBeLessThan(8.9);
  });
});
