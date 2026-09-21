// Replay-fixture tests (ANALYTICS_SPEC.md, Phase 3 test plan item 6). Every
// expected value in every fixtures/*.json file is derived by hand from that
// fixture's raw snapshots/trades/positions — the derivation for each
// fixture is documented inline below, next to the case that exercises it.
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { applyFixture, loadFixture } from './fixture-loader';
import { analyticsServiceFor } from './helpers';

const FIXTURE_NAMES = [
  'empty-account',
  'normal-trading-history',
  'profitable-history',
  'losing-history',
  'mixed-history',
  'multiple-positions',
  'partial-close-scenario',
  'consecutive-losses',
  'consecutive-wins',
  'bad-session',
] as const;

describe('analytics replay fixtures', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  for (const name of FIXTURE_NAMES) {
    it(`${name}: current metrics match hand-derived expected values`, async () => {
      const fixture = loadFixture(name);
      const accountId = await applyFixture(prisma, fixture);
      const service = analyticsServiceFor(prisma, fixture.baselineWindowDays);

      const current = await service.getCurrentMetrics(accountId, new Date(fixture.now));

      expect(current.account).toEqual(fixture.expectedCurrent.account);
      expect(current.activity).toEqual(fixture.expectedCurrent.activity);
      expect(current.position).toEqual(fixture.expectedCurrent.position);
      expect(current.frequency).toEqual(fixture.expectedCurrent.frequency);
      expect(current.sequences).toEqual(fixture.expectedCurrent.sequences);
    });

    it(`${name}: historical baselines match hand-derived expected values`, async () => {
      const fixture = loadFixture(name);
      const accountId = await applyFixture(prisma, fixture);
      const service = analyticsServiceFor(prisma, fixture.baselineWindowDays);

      const baselines = await service.getHistoricalBaselines(accountId, {
        now: new Date(fixture.now),
        windowDays: fixture.baselineWindowDays,
      });

      const { windowStart, windowEnd, ...rest } = baselines;
      const expected = fixture.expectedBaselines as Record<string, unknown>;

      expect(windowStart.toISOString()).toBe(expected.windowStart);
      expect(windowEnd.toISOString()).toBe(expected.windowEnd);
      expect(rest).toEqual({
        windowDays: expected.windowDays,
        averageDailyPl: expected.averageDailyPl,
        averageDailyLoss: expected.averageDailyLoss,
        averageTradesPerDay: expected.averageTradesPerDay,
        averagePositionVolume: expected.averagePositionVolume,
        maximumNormalPositionVolume: expected.maximumNormalPositionVolume,
        averageTradeDuration: expected.averageTradeDuration,
        averageLosingTrade: expected.averageLosingTrade,
        averageWinningTrade: expected.averageWinningTrade,
        averageTradesPerHour: expected.averageTradesPerHour,
      });
    });
  }
});
