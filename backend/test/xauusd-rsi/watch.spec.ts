/**
 * The watch cycle's cold-start behaviour.
 *
 * The case that matters here was found by running the real process rather
 * than by reasoning: seeding the indicator from candle history leaves the
 * engine's clock at the last bar it applied, so any tick older than that is
 * already inside the indicator and is correctly rejected as out-of-order. If
 * the observation cursor is not moved forward at the same time, the loop
 * re-reads and discards the same historical ticks on every cycle, forever.
 *
 * Observed live on a cold start before the fix: 44,992 ticks read, 44,992
 * rejected, zero applied, and an RSI frozen at one value.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RsiAccountStateService } from '../../src/xauusd-rsi/account-state.service';
import { RsiCoordinatorService } from '../../src/xauusd-rsi/coordinator.service';
import { RsiLiquidationService } from '../../src/xauusd-rsi/liquidation.service';
import { RsiRuntimeSettingsService } from '../../src/xauusd-rsi/runtime-settings.service';
import { RsiWatchService } from '../../src/xauusd-rsi/watch.service';
import { RsiDecisionService } from '../../src/xauusd-rsi/decision.service';
import { createWatchState, RsiWatchStore } from '../../src/xauusd-rsi/state-store';
import { SPEC } from '../../src/xauusd-rsi/spec';
import { M1_MS } from '../../src/xauusd-rsi/engine';
import { RSI_BROKER_SERVER_TIMEZONE, RSI_CURSOR_TIME_BASIS } from '../../src/xauusd-rsi/tick-time';
import { utcToWallClockMs } from '../../src/research/confirmed-retest/time';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Wednesday 2026-09-23, 15:00 Beirut — an ordinary eligible instant. */
const NOW_T = Date.parse('2026-09-23T12:00:00.000Z');

/**
 * Candle and tick rows are stored the way the collector really stores them:
 * broker wall-clock digits wearing a UTC label (see
 * `src/xauusd-rsi/tick-time.ts`). The fixtures write through this so they
 * exercise the same conversion the live path does; every assertion below
 * stays in true UTC.
 */
const stored = (utcMs: number) => new Date(utcToWallClockMs(RSI_BROKER_SERVER_TIMEZONE, utcMs));
const BARS = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars + 20;

describe('Watch cycle — cold start', () => {
  let prisma: PrismaClient;
  let watch: RsiWatchService;
  let accountId: string;
  let store: RsiWatchStore;

  beforeAll(() => {
    prisma = new PrismaClient();
    const accountState = new RsiAccountStateService(prisma as never);
    const runtimeSettings = new RsiRuntimeSettingsService();
    const coordinator = new RsiCoordinatorService(prisma as never, runtimeSettings, accountState);
    const liquidation = new RsiLiquidationService(prisma as never, accountState);
    const decisions = new RsiDecisionService(prisma as never, accountState);
    // Telegram is stubbed: this file is about observation, and a real send
    // would be an outbound network call from a unit test.
    // Stubbed in full: the cycle also sweeps failed deliveries, and a stub
    // missing that method would fail for a reason unrelated to this file.
    const telegram = { notify: async () => undefined, retryFailed: async () => ({ attempted: 0, sent: 0, gaveUp: 0 }) } as never;
    watch = new RsiWatchService(prisma as never, coordinator, accountState, liquidation, decisions, telegram);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    accountId = account.id;
    store = new RsiWatchStore(mkdtempSync(join(tmpdir(), 'rsi-watch-state-')));
  });

  /** A contiguous run of M1 bars ending just before `endT`. */
  async function seedCandles(endT: number) {
    const rows = [];
    for (let i = BARS; i >= 1; i -= 1) {
      const openTime = stored(endT - i * M1_MS);
      const base = 4300 + Math.sin(i / 7) * 3;
      rows.push({
        symbol: 'XAUUSD',
        timeframe: 'M1' as const,
        openTime,
        open: base,
        high: base + 0.5,
        low: base - 0.5,
        close: base,
        volume: 10,
      });
    }
    await prisma.historicalCandle.createMany({ data: rows });
  }

  /** Ticks positioned BEFORE the candle history ends — the trap case. */
  async function seedStaleTicks(endT: number, count: number) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      rows.push({
        symbol: 'XAUUSD',
        timestamp: stored(endT - (count - i) * 1_000 - 10 * M1_MS),
        bid: 4300 + i * 0.01,
        ask: 4300.18 + i * 0.01,
        flags: 6,
        batchSeq: i,
      });
    }
    await prisma.historicalTick.createMany({ data: rows });
  }

  it('moves the observation cursor to the end of the seeded range, instead of re-reading history forever', async () => {
    await seedCandles(NOW_T);
    await seedStaleTicks(NOW_T, 200);

    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const first = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    expect(first.result.reseeded).toBe(true);
    expect(first.result.warmedUp).toBe(true);

    // The cursor now sits at the seed boundary, so the stale ticks are simply
    // not read — they are not read-and-rejected.
    const lastBarT = NOW_T - M1_MS;
    expect(first.state.cursor.lastTimestampMs).toBe(lastBarT + M1_MS);
    expect(first.state.engine.ticksRejectedOutOfOrder).toBe(0);

    // A second cycle finds nothing new rather than re-reading the same ticks.
    const second = await watch.runCycle({ accountId, store, state: first.state, nowT: NOW_T + 5_000 });
    expect(second.result.ticksConsumed).toBe(0);
    expect(second.state.engine.ticksRejectedOutOfOrder).toBe(0);
  });

  it('consumes ticks that arrive AFTER the seeded range', async () => {
    await seedCandles(NOW_T);
    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const first = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    // Fresh ticks, after the last seeded bar.
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push({
        symbol: 'XAUUSD',
        timestamp: stored(NOW_T + i * 1_000),
        bid: 4302 + i * 0.05,
        ask: 4302.18 + i * 0.05,
        flags: 6,
        batchSeq: i,
      });
    }
    await prisma.historicalTick.createMany({ data: rows });

    const second = await watch.runCycle({ accountId, store, state: first.state, nowT: NOW_T + 21_000 });
    expect(second.result.ticksConsumed).toBe(20);
    expect(second.state.engine.ticksApplied).toBe(20);
    expect(second.state.engine.ticksRejectedOutOfOrder).toBe(0);
    expect(second.result.currentRsi).not.toBeNull();
  });

  it('completes recovery when there is nothing in flight, and reports it', async () => {
    await seedCandles(NOW_T);
    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const result = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    expect(result.result.recoveryComplete).toBe(true);
    expect(result.result.recoveryDetail).toMatch(/No in-flight decisions/);
  });

  it('retires an unsent decision left behind by a restart, and does not submit it', async () => {
    await seedCandles(NOW_T);
    const planted = await prisma.xauusdRsiDecision.create({
      data: {
        strategyVersion: SPEC.strategyVersion,
        specHash: 'whatever',
        accountId,
        symbol: 'XAUUSD',
        observedAt: new Date(NOW_T - 600_000),
        direction: 'SELL',
        ruleFamily: 'EXTREME',
        eventId: 'test-restart-1',
        setupKinds: ['EXTREME_SELL'],
        rsiValue: 99,
        basisPrice: 4300,
        observationMode: 'TICK',
        reasoning: 'planted by a restart test',
        evidence: {},
        approved: true,
        orderStatus: 'PENDING',
        magicNumber: 262610191,
      },
    });

    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: planted.id } });
    expect(after.orderStatus).toBe('NONE');
    expect(after.skipReason).toMatch(/restarted before this queued entry was ever sent/);
  });

  it('keeps entries blocked while an UNKNOWN submission is unresolved', async () => {
    await seedCandles(NOW_T);
    await prisma.xauusdRsiDecision.create({
      data: {
        strategyVersion: SPEC.strategyVersion,
        specHash: 'whatever',
        accountId,
        symbol: 'XAUUSD',
        observedAt: new Date(NOW_T - 600_000),
        direction: 'BUY',
        ruleFamily: 'EXTREME',
        eventId: 'test-restart-2',
        setupKinds: ['EXTREME_BUY'],
        rsiValue: 1,
        basisPrice: 4300,
        observationMode: 'TICK',
        reasoning: 'planted by a restart test',
        evidence: {},
        approved: true,
        orderStatus: 'SENT',
        magicNumber: 262610191,
      },
    });

    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const result = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    // No matching open position, so the outcome stays genuinely unknown and
    // recovery does NOT complete — it is never assumed to have failed.
    expect(result.result.recoveryComplete).toBe(false);
    expect(result.result.recoveryDetail).toMatch(/UNKNOWN/);
    expect(result.result.entriesAllowed).toBe(false);
  });
});

describe('Watch cycle — migrating off the pre-correction time basis', () => {
  let prisma: PrismaClient;
  let watch: RsiWatchService;
  let accountId: string;
  let store: RsiWatchStore;

  beforeAll(() => {
    prisma = new PrismaClient();
    const accountState = new RsiAccountStateService(prisma as never);
    const runtimeSettings = new RsiRuntimeSettingsService();
    const coordinator = new RsiCoordinatorService(prisma as never, runtimeSettings, accountState);
    const liquidation = new RsiLiquidationService(prisma as never, accountState);
    const decisions = new RsiDecisionService(prisma as never, accountState);
    // Stubbed in full: the cycle also sweeps failed deliveries, and a stub
    // missing that method would fail for a reason unrelated to this file.
    const telegram = { notify: async () => undefined, retryFailed: async () => ({ attempted: 0, sent: 0, gaveUp: 0 }) } as never;
    watch = new RsiWatchService(prisma as never, coordinator, accountState, liquidation, decisions, telegram);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    accountId = account.id;
    store = new RsiWatchStore(mkdtempSync(join(tmpdir(), 'rsi-watch-state-')));
  });

  async function seedCandlesAndTicks(endT: number) {
    const candles = [];
    for (let i = BARS; i >= 1; i -= 1) {
      const base = 4300 + Math.sin(i / 7) * 3;
      candles.push({
        symbol: 'XAUUSD', timeframe: 'M1' as const, openTime: stored(endT - i * M1_MS),
        open: base, high: base + 0.5, low: base - 0.5, close: base, volume: 10,
      });
    }
    await prisma.historicalCandle.createMany({ data: candles });
    const ticks = [];
    for (let i = 0; i < 20; i += 1) {
      ticks.push({
        symbol: 'XAUUSD', timestamp: stored(endT + i * 1_000),
        bid: 4302 + i * 0.05, ask: 4302.18 + i * 0.05, flags: 6, batchSeq: i,
      });
    }
    await prisma.historicalTick.createMany({ data: ticks });
  }

  it('rebuilds the ENGINE as well as the cursor, so corrected ticks are not all rejected', async () => {
    await seedCandlesAndTicks(NOW_T);

    // A state persisted by the pre-correction build: warmed up, with its
    // clock three hours ahead on the broker's wall-clock timeline, and an
    // untagged cursor. Resetting only the cursor leaves this engine in
    // place, and every corrected tick then looks three hours out of order.
    const stale = createWatchState(SPEC.strategyVersion, 'TICK');
    const staleEngineT = utcToWallClockMs(RSI_BROKER_SERVER_TIMEZONE, NOW_T);
    const poisoned = {
      ...stale,
      engine: {
        ...stale.engine,
        lastObservationT: staleEngineT,
        lastClosedBarT: staleEngineT - M1_MS,
        closedBarsApplied: 600,
      },
      cursor: { lastTimestampMs: staleEngineT, lastTickKey: null, lastTimestampKeys: [] },
    } as typeof stale;

    const result = await watch.runCycle({ accountId, store, state: poisoned, nowT: NOW_T + 25_000 });

    // Either reason is correct here — both conditions hold for this state,
    // and what matters is that the engine was rebuilt, not which check
    // noticed first.
    expect(result.result.notes.join(' ')).toMatch(/older time basis|engine clock is .* in the FUTURE/);
    // The engine was rebuilt from history on the corrected timeline...
    expect(result.result.reseeded).toBe(true);
    expect(result.state.cursor.timeBasis).toBe(RSI_CURSOR_TIME_BASIS);
    // ...and its clock is no longer three hours in the future.
    expect(result.state.engine.lastObservationT).toBeLessThan(NOW_T + 60_000);
    // The frozen-RSI symptom: with the old engine kept, nothing is applied.
    expect(result.state.engine.closedBarsApplied).toBeGreaterThan(0);
  });

  it('a second cycle then consumes new ticks normally instead of rejecting them', async () => {
    await seedCandlesAndTicks(NOW_T);
    const stale = createWatchState(SPEC.strategyVersion, 'TICK');
    const staleEngineT = utcToWallClockMs(RSI_BROKER_SERVER_TIMEZONE, NOW_T);
    const poisoned = {
      ...stale,
      engine: { ...stale.engine, lastObservationT: staleEngineT, lastClosedBarT: staleEngineT - M1_MS, closedBarsApplied: 600 },
      cursor: { lastTimestampMs: staleEngineT, lastTickKey: null, lastTimestampKeys: [] },
    } as typeof stale;

    const first = await watch.runCycle({ accountId, store, state: poisoned, nowT: NOW_T + 25_000 });
    const oooAfterFirst = first.state.engine.ticksRejectedOutOfOrder;

    // More ticks arrive after the migration cycle.
    await prisma.historicalTick.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        symbol: 'XAUUSD', timestamp: stored(NOW_T + 30_000 + i * 1_000),
        bid: 4305 + i * 0.05, ask: 4305.18 + i * 0.05, flags: 6, batchSeq: 100 + i,
      })),
    });

    const second = await watch.runCycle({ accountId, store, state: first.state, nowT: NOW_T + 36_000 });

    expect(second.result.ticksConsumed).toBeGreaterThan(0);
    // No NEW out-of-order rejections: the timelines agree now.
    expect(second.state.engine.ticksRejectedOutOfOrder).toBe(oooAfterFirst);
  });

  it('a cursor already on the current basis is left alone', async () => {
    await seedCandlesAndTicks(NOW_T);
    const fresh = createWatchState(SPEC.strategyVersion, 'TICK');
    expect(fresh.cursor.timeBasis).toBe(RSI_CURSOR_TIME_BASIS);

    const result = await watch.runCycle({ accountId, store, state: fresh, nowT: NOW_T + 25_000 });
    expect(result.result.notes.join(' ')).not.toMatch(/older time basis/);
  });
  it('self-heals a future engine clock even when the cursor is ALREADY tagged current', async () => {
    // The exact state the running system got into: an earlier, cursor-only
    // migration stamped the current basis onto the cursor while leaving the
    // engine three hours ahead. A tag-keyed guard stops firing; the damage
    // persists; RSI stays frozen while the loop looks healthy.
    await seedCandlesAndTicks(NOW_T);
    const stale = createWatchState(SPEC.strategyVersion, 'TICK');
    const staleEngineT = utcToWallClockMs(RSI_BROKER_SERVER_TIMEZONE, NOW_T);
    const poisoned = {
      ...stale,
      engine: { ...stale.engine, lastObservationT: staleEngineT, lastClosedBarT: staleEngineT - M1_MS, closedBarsApplied: 600 },
      // Tagged CURRENT — this is what defeated the previous guard.
      cursor: { lastTimestampMs: NOW_T, lastTickKey: null, lastTimestampKeys: [], timeBasis: RSI_CURSOR_TIME_BASIS },
    } as typeof stale;

    const result = await watch.runCycle({ accountId, store, state: poisoned, nowT: NOW_T + 25_000 });

    expect(result.result.notes.join(' ')).toMatch(/engine clock is .* in the FUTURE/);
    expect(result.state.engine.lastObservationT).toBeLessThan(NOW_T + 60_000);
    expect(result.result.reseeded).toBe(true);
  });

  it('leaves a healthy engine clock alone', async () => {
    await seedCandlesAndTicks(NOW_T);
    const fresh = createWatchState(SPEC.strategyVersion, 'TICK');
    const first = await watch.runCycle({ accountId, store, state: fresh, nowT: NOW_T + 25_000 });
    // Second cycle on a normal, just-built state must not rebuild again.
    const second = await watch.runCycle({ accountId, store, state: first.state, nowT: NOW_T + 26_000 });
    expect(second.result.notes.join(' ')).not.toMatch(/FUTURE/);
    expect(second.result.reseeded).toBe(false);
  });
});
