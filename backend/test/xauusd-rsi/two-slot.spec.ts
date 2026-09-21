/**
 * The two-slot execution model (spec `ruleFamilies`).
 *
 * The rule is narrow and easy to over-apply, so these cases pin both edges:
 * a retest and an extreme MAY be open at once, and a second entry in the same
 * family may NOT — it is not one slot per directional setup, and it is not an
 * unrestricted free-for-all either.
 *
 * Driven through the real coordinator against the real database, because the
 * slot reservation's atomicity lives in a partial unique index rather than in
 * application code, and a test that stubbed the database would not exercise
 * the thing that actually enforces it.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RsiAccountStateService } from '../../src/xauusd-rsi/account-state.service';
import { RsiCoordinatorService } from '../../src/xauusd-rsi/coordinator.service';
import { RsiRuntimeSettingsService } from '../../src/xauusd-rsi/runtime-settings.service';
import { EmittedSignal } from '../../src/xauusd-rsi/engine';
import { RuleFamily } from '../../src/xauusd-rsi/pattern';
import { SPEC, SPEC_HASH } from '../../src/xauusd-rsi/spec';
import { RSI_MAGIC_EXTREME, RSI_MAGIC_RETEST } from '../../src/xauusd-rsi/safety-constants';

/** Wednesday 2026-09-23, 15:00 Beirut — plainly eligible. */
const NOW_T = Date.parse('2026-09-23T12:00:00.000Z');

describe('Two rule-family slots', () => {
  let prisma: PrismaClient;
  let coordinator: RsiCoordinatorService;
  let accountState: RsiAccountStateService;
  let accountId: string;
  let originalMode: string | undefined;

  beforeAll(() => {
    originalMode = process.env.XAUUSD_RSI_EXECUTION_MODE;
    process.env.XAUUSD_RSI_EXECUTION_MODE = 'DEMO';
    prisma = new PrismaClient();
    accountState = new RsiAccountStateService(prisma as never);
    coordinator = new RsiCoordinatorService(prisma as never, new RsiRuntimeSettingsService(), accountState);
  });
  afterAll(async () => {
    if (originalMode === undefined) delete process.env.XAUUSD_RSI_EXECUTION_MODE;
    else process.env.XAUUSD_RSI_EXECUTION_MODE = originalMode;
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    accountId = account.id;
    await seed(50_000, 'RETAIL_HEDGING');
  });

  async function seed(equity: number, marginMode: 'RETAIL_HEDGING' | 'RETAIL_NETTING') {
    await prisma.accountSnapshot.create({
      data: {
        accountId, tradeMode: 'DEMO', marginMode, balance: equity, equity,
        margin: 0, freeMargin: equity, profit: 0, capturedAt: new Date(NOW_T),
      },
    });
    await prisma.symbolMetadata.upsert({
      where: { symbol: 'XAUUSD' },
      create: {
        symbol: 'XAUUSD', volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, digits: 2,
        point: 0.01, contractSize: 100, profitCurrency: 'USD', tradeStopsLevel: 0,
        tradeFreezeLevel: 0, tradeTickSize: 0.01, tradeMode: 4,
      },
      update: {},
    });
    // `updatedAt` is managed by Prisma, so it lands at real wall-clock time.
    // These cases evaluate at a FIXED instant that may be days away from that,
    // and the broker-constraint reader deliberately treats metadata older than
    // 24h as unusable. Pinning it to the test's own clock keeps the fixture
    // fresh from the code's point of view without weakening that staleness
    // rule, and stops these tests from depending on the date they run on.
    await prisma.$executeRawUnsafe(
      `UPDATE symbol_metadata SET updated_at = $1 WHERE symbol = 'XAUUSD'`,
      new Date(NOW_T),
    );
    // Account currency is USD in these fixtures, so no FX conversion is needed
    // and the risk arithmetic stays legible.
    await prisma.tradingAccount.update({ where: { id: accountId }, data: { currency: 'USD' } });
  }

  function signal(family: RuleFamily, direction: 'BUY' | 'SELL', atT = NOW_T): EmittedSignal {
    const kinds =
      family === 'RETEST'
        ? [direction === 'SELL' ? ('SELL_PEAK_RETEST' as const) : ('BUY_TROUGH_RETEST' as const)]
        : [direction === 'SELL' ? ('EXTREME_SELL' as const) : ('EXTREME_BUY' as const)];
    return {
      family,
      direction,
      kinds,
      reason: `test ${family} ${direction}`,
      rsi: direction === 'SELL' ? 99 : 1,
      atT,
      basisPrice: 4345,
      evidence: {
        specHash: SPEC_HASH,
        strategyVersion: SPEC.strategyVersion,
        observationMode: 'TICK',
        previousRsi: 50,
        currentRsi: direction === 'SELL' ? 99 : 1,
        formingMinuteT: NOW_T,
        lastClosedBarT: NOW_T - 60_000,
        closedBarsApplied: 500,
        triggered: [],
        thresholds: SPEC.thresholds,
      },
    };
  }

  const ctx = (nowT = NOW_T) => ({
    accountId,
    nowT,
    currentExecutablePrice: 4345,
    brokerSessionOpen: true as boolean | null,
    brokerSessionDetail: 'test',
    dataFresh: true,
    recoveryComplete: true,
  });

  it('allows a RETEST and an EXTREME position to coexist', async () => {
    const first = await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
    expect(first.queued).toBe(true);

    const second = await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());
    expect(second.queued).toBe(true);
    expect(second.skipReason).toBeNull();

    const rows = await prisma.xauusdRsiDecision.findMany({ where: { orderStatus: 'PENDING' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ruleFamily).sort()).toEqual(['EXTREME', 'RETEST']);
    // Each carries its own family's magic, so each resulting ticket is
    // attributable to one slot.
    expect(rows.find((r) => r.ruleFamily === 'RETEST')?.magicNumber).toBe(RSI_MAGIC_RETEST);
    expect(rows.find((r) => r.ruleFamily === 'EXTREME')?.magicNumber).toBe(RSI_MAGIC_EXTREME);
  });

  it('blocks a SECOND entry in the same family', async () => {
    const first = await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
    expect(first.queued).toBe(true);

    // A BUY retest is a different setup but the SAME family, so it is blocked.
    const second = await coordinator.evaluate(signal('RETEST', 'BUY'), ctx());
    expect(second.queued).toBe(false);
    expect(second.skipReason).toMatch(/RETEST slot is already held/);
  });

  it('blocks a second EXTREME entry too', async () => {
    await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());
    const second = await coordinator.evaluate(signal('EXTREME', 'BUY'), ctx());
    expect(second.queued).toBe(false);
    expect(second.skipReason).toMatch(/EXTREME slot is already held/);
  });

  it('accepts both families from ONE observation', async () => {
    // The engine emits one signal per family for a single observation; both
    // must be able to reach the broker.
    const atT = NOW_T;
    const a = await coordinator.evaluate(signal('RETEST', 'SELL', atT), ctx());
    const b = await coordinator.evaluate(signal('EXTREME', 'SELL', atT), ctx());

    expect([a.queued, b.queued]).toEqual([true, true]);
    const rows = await prisma.xauusdRsiDecision.findMany({ where: { orderStatus: 'PENDING' } });
    // Separately identified, never merged into one order.
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(2);
  });

  it('maximum concurrency is TWO, not four', async () => {
    await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
    await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());
    const third = await coordinator.evaluate(signal('RETEST', 'BUY'), ctx());
    const fourth = await coordinator.evaluate(signal('EXTREME', 'BUY'), ctx());

    expect(third.queued).toBe(false);
    expect(fourth.queued).toBe(false);
    expect(await prisma.xauusdRsiDecision.count({ where: { orderStatus: 'PENDING' } })).toBe(2);
  });

  describe('aggregate risk accounting', () => {
    it("counts the first reservation toward the second entry's combined cap", async () => {
      // $5 x 100oz x 0.5 lots = $250 of stop risk per position. At $50,000
      // equity the per-trade cap (0.5% = $250) admits one, and the combined
      // cap (1% = $500) admits exactly two — so a little pre-existing risk is
      // what makes the second one the trade that tips over the line.
      //
      // The existing risk is a EURUSD position, deliberately not XAUUSD: it
      // must add to combined risk without touching either gold slot, so this
      // case isolates the ARITHMETIC rather than re-testing occupancy.
      await prisma.position.create({
        data: {
          accountId, platform: 'MT5', externalPositionId: 'eu-1', symbol: 'EURUSD',
          side: 'BUY', volume: 0.1, openPrice: 1.1, profit: -60, swap: 0,
          openedAt: new Date(NOW_T), status: 'OPEN',
        },
      });

      // First: 60 + 250 = 310 of 500. Fits.
      const first = await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
      expect(first.queued).toBe(true);

      // Second: 60 + 250 already reserved + 250 = 560 of 500. Does not fit —
      // and it only exceeds because the first reservation is counted.
      const second = await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());
      expect(second.queued).toBe(false);
      expect(second.skipReason).toMatch(/combined cap/);
    });

    it('would have admitted the second entry had the first NOT been counted', async () => {
      // The control for the case above: same account, same pre-existing risk,
      // but with the first slot never reserved. If the reservation were not
      // counted, 60 + 250 = 310 of 500 would fit — so this passing is what
      // makes the previous failure attributable to the reservation.
      await prisma.position.create({
        data: {
          accountId, platform: 'MT5', externalPositionId: 'eu-1', symbol: 'EURUSD',
          side: 'BUY', volume: 0.1, openPrice: 1.1, profit: -60, swap: 0,
          openedAt: new Date(NOW_T), status: 'OPEN',
        },
      });

      const only = await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());
      expect(only.queued).toBe(true);
    });

    it('allows both when equity comfortably covers the combined risk', async () => {
      await prisma.accountSnapshot.deleteMany();
      await seed(100_000, 'RETAIL_HEDGING');

      expect((await coordinator.evaluate(signal('RETEST', 'SELL'), ctx())).queued).toBe(true);
      expect((await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx())).queued).toBe(true);
    });

    it('records the reserved risk it counted, so the arithmetic is auditable', async () => {
      await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
      const second = await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());

      const row = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: second.decisionId } });
      const evidence = row.evidence as Record<string, any>;
      expect(evidence.reservedStopRisk.count).toBe(1);
      expect(evidence.reservedStopRisk.amount).toBeCloseTo(250, 2);
      expect(evidence.otherFamilySlotHeld).toBe(true);
    });
  });

  describe('atomic slot reservation', () => {
    it('lets only ONE of two concurrent same-family evaluations through', async () => {
      const [a, b] = await Promise.all([
        coordinator.evaluate(signal('RETEST', 'SELL'), ctx()),
        coordinator.evaluate(signal('RETEST', 'BUY'), ctx()),
      ]);

      const queued = [a, b].filter((r) => r.queued);
      expect(queued).toHaveLength(1);
      expect(await prisma.xauusdRsiDecision.count({ where: { orderStatus: 'PENDING' } })).toBe(1);

      // The loser is recorded with a reason, never silently dropped.
      const loser = [a, b].find((r) => !r.queued)!;
      expect(loser.skipReason).toBeTruthy();
    });

    it('lets two concurrent DIFFERENT-family evaluations both through', async () => {
      const [a, b] = await Promise.all([
        coordinator.evaluate(signal('RETEST', 'SELL'), ctx()),
        coordinator.evaluate(signal('EXTREME', 'SELL'), ctx()),
      ]);
      expect([a.queued, b.queued]).toEqual([true, true]);
    });

    it('a skipped decision never holds a slot, however many accumulate', async () => {
      // Fill and then free the slot repeatedly via blocked signals.
      for (let i = 0; i < 5; i += 1) {
        await coordinator.evaluate(signal('RETEST', 'SELL', NOW_T + i), { ...ctx(), brokerSessionOpen: false });
      }
      expect(await prisma.xauusdRsiDecision.count()).toBe(5);

      // The slot is still free.
      const slots = await accountState.resolveSlotStates(accountId);
      expect(slots.RETEST.occupied).toBe(false);
      expect((await coordinator.evaluate(signal('RETEST', 'SELL'), ctx())).queued).toBe(true);
    });
  });

  describe('slot state across a restart', () => {
    it('restores BOTH slots from persisted state', async () => {
      await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
      await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());

      // A fresh service instance, as a restart would produce: slot state is
      // read from the database, never from process memory.
      const revived = new RsiAccountStateService(prisma as never);
      const slots = await revived.resolveSlotStates(accountId);

      expect(slots.RETEST.occupied).toBe(true);
      expect(slots.EXTREME.occupied).toBe(true);
      expect(slots.RETEST.reason).toMatch(/RETEST/);
      expect(slots.EXTREME.reason).toMatch(/EXTREME/);
    });

    it('reports a free slot after its decision is released', async () => {
      const first = await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
      await prisma.xauusdRsiDecision.update({
        where: { id: first.decisionId },
        data: { orderStatus: 'FAILED', slotReleasedAt: new Date() },
      });

      const slots = await new RsiAccountStateService(prisma as never).resolveSlotStates(accountId);
      expect(slots.RETEST.occupied).toBe(false);
    });

    it('an open POSITION holds its family slot even with no in-flight decision', async () => {
      await prisma.position.create({
        data: {
          accountId, platform: 'MT5', externalPositionId: '4242', symbol: 'XAUUSD',
          side: 'SELL', volume: 0.5, openPrice: 4345, profit: 0, swap: 0,
          openedAt: new Date(NOW_T), status: 'OPEN', rawPayload: { magic: RSI_MAGIC_EXTREME },
        },
      });

      const slots = await accountState.resolveSlotStates(accountId);
      expect(slots.EXTREME.occupied).toBe(true);
      expect(slots.RETEST.occupied).toBe(false);

      // And the free family can still trade.
      expect((await coordinator.evaluate(signal('RETEST', 'SELL'), ctx())).queued).toBe(true);
      // While the held one cannot.
      expect((await coordinator.evaluate(signal('EXTREME', 'BUY'), ctx())).queued).toBe(false);
    });
  });

  describe('broker account compatibility', () => {
    it('refuses the SECOND position on a netting account rather than emulating it', async () => {
      await prisma.accountSnapshot.deleteMany();
      await seed(100_000, 'RETAIL_NETTING');

      const first = await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
      expect(first.queued).toBe(true);

      const second = await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());
      expect(second.queued).toBe(false);
      expect(second.skipReason).toMatch(/RETAIL_NETTING/);
      expect(second.skipReason).toMatch(/merge with, reduce or reverse/);
    });

    it('refuses the second position when the margin mode is unknown', async () => {
      await prisma.accountSnapshot.deleteMany();
      await prisma.accountSnapshot.create({
        data: {
          accountId, tradeMode: 'DEMO', balance: 100_000, equity: 100_000,
          margin: 0, freeMargin: 100_000, profit: 0, capturedAt: new Date(NOW_T),
        },
      });

      expect((await coordinator.evaluate(signal('RETEST', 'SELL'), ctx())).queued).toBe(true);
      const second = await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());
      expect(second.queued).toBe(false);
      expect(second.skipReason).toMatch(/could not be established/);
    });
  });

  describe('unattributable exposure still blocks', () => {
    it('refuses both families while a foreign position is open', async () => {
      // The two-slot change relaxed same-symbol occupancy for this strategy's
      // own slots only. Exposure it cannot account for still blocks entirely.
      await prisma.position.create({
        data: {
          accountId, platform: 'MT5', externalPositionId: '9999', symbol: 'XAUUSD',
          side: 'BUY', volume: 1, openPrice: 4340, profit: 0, swap: 0,
          openedAt: new Date(NOW_T), status: 'OPEN', rawPayload: { magic: 777777 },
        },
      });

      const a = await coordinator.evaluate(signal('RETEST', 'SELL'), ctx());
      const b = await coordinator.evaluate(signal('EXTREME', 'SELL'), ctx());

      expect(a.queued).toBe(false);
      expect(b.queued).toBe(false);
      expect(a.skipReason).toMatch(/cannot attribute to an execution slot/);
    });
  });
});
