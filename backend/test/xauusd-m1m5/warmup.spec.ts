/**
 * Re-warming a resumed state that is not warm, against a real database.
 *
 * Reproduces what was measured on the VPS: M5 resumed at 94 of 256 closed
 * bars while the database held far more M5 candles than it needed, so M5
 * produced no RSI and could never trade.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEngineState, warmUpFromClosedBars } from '../../src/xauusd-m1m5/engine';
import { isWarmedUp } from '../../src/xauusd-m1m5/rsi';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from '../../src/xauusd-m1m5/spec';
import type { WatchState } from '../../src/xauusd-m1m5/state-store';
import { rewarmColdTimeframes, WARMUP_BARS_NEEDED } from '../../src/xauusd-m1m5/warmup';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();

/** A gently oscillating series, so RSI is defined and neither 0 nor 100. */
function closes(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 4300 + 5 * Math.sin(i / 3) + (i % 7) * 0.3);
}

async function seedCandles(timeframe: Timeframe, count: number) {
  const stepMs = timeframe === 'M1' ? 60_000 : 300_000;
  const start = Date.parse('2026-09-20T00:00:00Z');
  await prisma.historicalCandle.createMany({
    data: closes(count).map((close, i) => ({
      symbol: 'XAUUSD',
      timeframe,
      openTime: new Date(start + i * stepMs),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    })),
  });
}

/** A resumed state: M1 warm, M5 with only `m5Bars` closed bars. */
function resumedState(m5Bars: number): WatchState {
  const m1 = warmUpFromClosedBars(createEngineState('M1'), closes(464));
  const m5 = warmUpFromClosedBars(createEngineState('M5'), closes(m5Bars));
  return {
    strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
    specHash: SPEC_HASH,
    accountId: null,
    lastCycleAtMs: Date.now(),
    lastCycleIntervalMs: null,
    lastSubmissionLatencyMs: null,
    engines: { M1: m1, M5: m5 },
    crossings: { M1: m1.crossing, M5: m5.crossing },
    observationLimitations: [],
    recoveryCompleteAtMs: Date.now(),
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('rewarmColdTimeframes', () => {
  it('re-warms a cold M5 from history -- the VPS case, 94 of 256', async () => {
    await seedCandles('M5', 1000);
    const before = resumedState(94);
    expect(isWarmedUp(before.engines.M5.rsi)).toBe(false);

    const { state, rewarmed } = await rewarmColdTimeframes(prisma, before);

    expect(rewarmed).toEqual([{ timeframe: 'M5', fromBars: 94, toBars: WARMUP_BARS_NEEDED }]);
    expect(isWarmedUp(state.engines.M5.rsi)).toBe(true);
    expect(state.engines.M5.rsi.closedBarCount).toBe(WARMUP_BARS_NEEDED);
  });

  it('leaves a warm timeframe exactly as it was', async () => {
    await seedCandles('M1', 1000);
    await seedCandles('M5', 1000);
    const before = resumedState(94);

    const { state } = await rewarmColdTimeframes(prisma, before);

    // Same object: not re-read, not replaced.
    expect(state.engines.M1).toBe(before.engines.M1);
  });

  it('gives the re-warmed timeframe a FRESH crossing, so nothing is armed', async () => {
    // Warm-up must never be able to produce an entry. A fresh crossing has no
    // previous observation, so the next live one cannot complete a crossing
    // on its own; a real one still has to be observed.
    await seedCandles('M5', 1000);

    const { state } = await rewarmColdTimeframes(prisma, resumedState(94));

    expect(state.crossings.M5.previousRsi).toBeNull();
    expect(state.crossings.M5).toBe(state.engines.M5.crossing);
  });

  it('keeps the live count when history has fewer bars than it', async () => {
    await seedCandles('M5', 50);
    const before = resumedState(94);

    const { state, rewarmed } = await rewarmColdTimeframes(prisma, before);

    expect(rewarmed).toEqual([]);
    expect(state).toBe(before);
  });

  it('does nothing when every timeframe is already warm', async () => {
    await seedCandles('M5', 1000);
    const before = resumedState(300);

    const { state, rewarmed } = await rewarmColdTimeframes(prisma, before);

    expect(rewarmed).toEqual([]);
    expect(state).toBe(before);
  });
});
