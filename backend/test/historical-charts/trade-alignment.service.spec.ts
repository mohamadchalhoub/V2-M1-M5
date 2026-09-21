import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chooseTimeframe, TradeAlignmentService } from '../../src/historical-charts/trade-alignment.service';
import { HistoricalCandleService } from '../../src/market-data/historical-candle.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';

describe('chooseTimeframe', () => {
  it('M5 for a trade lasting up to 4 hours', () => {
    expect(chooseTimeframe(0)).toBe('M5');
    expect(chooseTimeframe(4 * 60 * 60_000)).toBe('M5');
  });
  it('M15 for a trade lasting between 4 and 48 hours', () => {
    expect(chooseTimeframe(4 * 60 * 60_000 + 1)).toBe('M15');
    expect(chooseTimeframe(48 * 60 * 60_000)).toBe('M15');
  });
  it('H1 for a trade lasting more than 48 hours', () => {
    expect(chooseTimeframe(48 * 60 * 60_000 + 1)).toBe('H1');
    expect(chooseTimeframe(30 * 24 * 60 * 60_000)).toBe('H1');
  });
});

describe('TradeAlignmentService', () => {
  let prisma: PrismaClient;
  let candles: HistoricalCandleService;
  let service: TradeAlignmentService;

  beforeAll(() => {
    prisma = new PrismaClient();
    candles = new HistoricalCandleService(prisma as unknown as PrismaService);
    service = new TradeAlignmentService(prisma as unknown as PrismaService, candles);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function xtbAccount() {
    const user = await createUser(prisma);
    return createTradingAccount(prisma, user.id, { platform: 'XTB' });
  }

  async function createRoundTrip(
    accountId: string,
    positionId: string,
    overrides: Partial<{
      side: 'BUY' | 'SELL';
      openedAt: Date;
      closedAt: Date;
      openPrice: number;
      closePrice: number;
      profit: number;
      commission: number;
      swap: number;
      stopLoss: number | null;
      takeProfit: number | null;
    }> = {},
  ) {
    const side = overrides.side ?? 'BUY';
    const openedAt = overrides.openedAt ?? new Date('2026-01-01T00:00:00Z');
    const closedAt = overrides.closedAt ?? new Date('2026-01-01T01:00:00Z');
    await prisma.trade.create({
      data: {
        accountId, platform: 'XTB', externalTradeId: `${positionId}-IN`, positionId,
        symbol: 'EURUSD', side, dealEntry: 'IN', volume: 0.1,
        price: overrides.openPrice ?? 1.1, executedAt: openedAt,
        stopLoss: overrides.stopLoss ?? null, takeProfit: overrides.takeProfit ?? null,
      },
    });
    await prisma.trade.create({
      data: {
        accountId, platform: 'XTB', externalTradeId: `${positionId}-OUT`, positionId,
        symbol: 'EURUSD', side, dealEntry: 'OUT', volume: 0.1,
        price: overrides.closePrice ?? 1.11, profit: overrides.profit ?? 10,
        commission: overrides.commission ?? 0, swap: overrides.swap ?? 0, executedAt: closedAt,
        stopLoss: overrides.stopLoss ?? null, takeProfit: overrides.takeProfit ?? null,
      },
    });
  }

  it('pairs IN/OUT trades into a round trip', async () => {
    const account = await xtbAccount();
    await createRoundTrip(account.id, 'p1', { side: 'SELL', openPrice: 1.2, closePrice: 1.19, profit: 10 });

    const trips = await service.getRoundTrips(account.id, 'EURUSD');
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ positionId: 'p1', side: 'SELL', entryPrice: 1.2, exitPrice: 1.19, profit: 10, netProfit: 10 });
  });

  // Audit finding (reconciliation session): a real position in this account's
  // own imported history has gross profit == 0 but a nonzero swap, making it
  // a net LOSER, not a breakeven — `netProfit` (not `profit`) must carry
  // that cost through, since `HistoricalPatternSummaryService` classifies
  // win/loss/breakeven off this field, not the raw gross figure.
  it('netProfit includes commission and swap — a gross-breakeven trade with negative swap is a net loser', async () => {
    const account = await xtbAccount();
    await createRoundTrip(account.id, 'p1', { profit: 0, swap: -1.5, commission: 0 });

    const trips = await service.getRoundTrips(account.id, 'EURUSD');
    expect(trips[0].profit).toBe(0);
    expect(trips[0].netProfit).toBe(-1.5);
  });

  it('excludes an incomplete position (only an IN leg, still open)', async () => {
    const account = await xtbAccount();
    await prisma.trade.create({
      data: {
        accountId: account.id, platform: 'XTB', externalTradeId: 'p2-IN', positionId: 'p2',
        symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1, executedAt: new Date(),
      },
    });
    const trips = await service.getRoundTrips(account.id, 'EURUSD');
    expect(trips).toHaveLength(0);
  });

  it('never mixes another account\'s trades into this account\'s round trips', async () => {
    const accountA = await xtbAccount();
    const accountB = await xtbAccount();
    await createRoundTrip(accountA.id, 'pA', {});
    await createRoundTrip(accountB.id, 'pB', {});

    const tripsA = await service.getRoundTrips(accountA.id, 'EURUSD');
    expect(tripsA.map((t) => t.positionId)).toEqual(['pA']);
  });

  describe('getAllRoundTrips', () => {
    it('combines round trips across every account, unlike getRoundTrips', async () => {
      const accountA = await xtbAccount();
      const accountB = await xtbAccount();
      await createRoundTrip(accountA.id, 'pA', {});
      await createRoundTrip(accountB.id, 'pB', {});

      const trips = await service.getAllRoundTrips('EURUSD');
      expect(trips.map((t) => t.positionId).sort()).toEqual(['pA', 'pB']);
    });

    it('does not pair an IN leg from one account with an OUT leg from another sharing the same position id', async () => {
      const accountA = await xtbAccount();
      const accountB = await xtbAccount();
      await createRoundTrip(accountA.id, 'shared', { side: 'BUY', profit: 10 });
      await createRoundTrip(accountB.id, 'shared', { side: 'SELL', profit: -20 });

      const trips = await service.getAllRoundTrips('EURUSD');
      expect(trips).toHaveLength(2);
      expect(trips.find((t) => t.side === 'BUY')?.profit).toBe(10);
      expect(trips.find((t) => t.side === 'SELL')?.profit).toBe(-20);
    });

    it('still excludes an incomplete position and still ignores other symbols', async () => {
      const account = await xtbAccount();
      await prisma.trade.create({
        data: {
          accountId: account.id, platform: 'XTB', externalTradeId: 'p2-IN', positionId: 'p2',
          symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1, executedAt: new Date(),
        },
      });
      await prisma.trade.create({
        data: {
          accountId: account.id, platform: 'XTB', externalTradeId: 'g1-IN', positionId: 'g1',
          symbol: 'GBPUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.3, executedAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      await prisma.trade.create({
        data: {
          accountId: account.id, platform: 'XTB', externalTradeId: 'g1-OUT', positionId: 'g1',
          symbol: 'GBPUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1, price: 1.31, profit: 10, executedAt: new Date('2026-01-01T01:00:00Z'),
        },
      });

      const trips = await service.getAllRoundTrips('EURUSD');
      expect(trips).toHaveLength(0);
    });
  });

  it('orders round trips by entry time ascending', async () => {
    const account = await xtbAccount();
    await createRoundTrip(account.id, 'later', { openedAt: new Date('2026-01-02T00:00:00Z'), closedAt: new Date('2026-01-02T01:00:00Z') });
    await createRoundTrip(account.id, 'earlier', { openedAt: new Date('2026-01-01T00:00:00Z'), closedAt: new Date('2026-01-01T01:00:00Z') });

    const trips = await service.getRoundTrips(account.id, 'EURUSD');
    expect(trips.map((t) => t.positionId)).toEqual(['earlier', 'later']);
  });

  it('getTradeChartWindow throws for an unknown positionId', async () => {
    const account = await xtbAccount();
    await expect(service.getTradeChartWindow(account.id, 'EURUSD', 'nope')).rejects.toThrow(/no closed/i);
  });

  it('reports a data limitation when no candles exist for the window at all', async () => {
    const account = await xtbAccount();
    await createRoundTrip(account.id, 'p1');
    const result = await service.getTradeChartWindow(account.id, 'EURUSD', 'p1');
    expect(result.candles).toHaveLength(0);
    expect(result.dataLimitation).toMatch(/no historical/i);
  });

  it('builds a full chart window with real candle data, correctly sliced into pre/during/post', async () => {
    const account = await xtbAccount();
    // 1-hour trade → M5 timeframe (chooseTimeframe: <=4h). Entry 00:00, exit 01:00.
    await createRoundTrip(account.id, 'p1', {
      side: 'BUY', openedAt: new Date('2026-01-01T00:00:00Z'), closedAt: new Date('2026-01-01T01:00:00Z'),
      openPrice: 1.1, closePrice: 1.105, profit: 5, stopLoss: 1.09, takeProfit: 1.11,
    });

    // Pre-entry candle (closes well before entry), one during, one post-exit.
    await candles.upsertCandles('EURUSD', 'M5', [
      { openTime: '2025-12-31T23:50:00.000Z', open: 1.099, high: 1.1, low: 1.098, close: 1.0995 }, // pre-entry
      { openTime: '2026-01-01T00:30:00.000Z', open: 1.1, high: 1.108, low: 1.099, close: 1.103 }, // during
      { openTime: '2026-01-01T01:10:00.000Z', open: 1.105, high: 1.107, low: 1.104, close: 1.106 }, // post-exit
    ]);

    const result = await service.getTradeChartWindow(account.id, 'EURUSD', 'p1');
    expect(result.timeframe).toBe('M5');
    expect(result.entryMarker).toEqual({ time: new Date('2026-01-01T00:00:00Z'), price: 1.1 });
    expect(result.exitMarker).toEqual({ time: new Date('2026-01-01T01:00:00Z'), price: 1.105, profit: 5 });
    expect(result.stopLoss).toBe(1.09);
    expect(result.takeProfit).toBe(1.11);
    expect(result.candles).toHaveLength(3);

    expect(result.features.preEntry.candleCount).toBe(1);
    expect(result.features.duringTrade.candleCount).toBe(1);
    expect(result.features.postExit.candleCount).toBe(1);
  });
});
