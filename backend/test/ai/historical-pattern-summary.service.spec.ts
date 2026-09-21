import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HistoricalPatternSummaryService } from '../../src/ai/historical-pattern-summary.service';
import { TradeAlignmentService } from '../../src/historical-charts/trade-alignment.service';
import { HistoricalCandleService } from '../../src/market-data/historical-candle.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';

describe('HistoricalPatternSummaryService', () => {
  let prisma: PrismaClient;
  let service: HistoricalPatternSummaryService;

  beforeAll(() => {
    prisma = new PrismaClient();
    const candles = new HistoricalCandleService(prisma as unknown as PrismaService);
    const tradeAlignment = new TradeAlignmentService(prisma as unknown as PrismaService, candles);
    service = new HistoricalPatternSummaryService(tradeAlignment);
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
    side: 'BUY' | 'SELL',
    profit: number,
    extra: { commission?: number; swap?: number } = {},
  ) {
    await prisma.trade.create({
      data: {
        accountId, platform: 'XTB', externalTradeId: `${positionId}-IN`, positionId,
        symbol: 'EURUSD', side, dealEntry: 'IN', volume: 0.1,
        price: 1.1, executedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.trade.create({
      data: {
        accountId, platform: 'XTB', externalTradeId: `${positionId}-OUT`, positionId,
        symbol: 'EURUSD', side, dealEntry: 'OUT', volume: 0.1,
        price: 1.11, profit, commission: extra.commission ?? 0, swap: extra.swap ?? 0,
        executedAt: new Date('2026-01-01T01:00:00Z'),
      },
    });
  }

  it('returns zero-sample, null-stat, LOW-confidence sides when there is no EURUSD history anywhere', async () => {
    await xtbAccount();
    const result = await service.build();
    expect(result).toEqual({
      symbol: 'EURUSD',
      buy: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
      sell: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
    });
  });

  it('computes sample size, win rate, and average P&L per side, independently', async () => {
    const account = await xtbAccount();
    await createRoundTrip(account.id, 'b1', 'BUY', 10);
    await createRoundTrip(account.id, 'b2', 'BUY', -4);
    await createRoundTrip(account.id, 's1', 'SELL', 6);

    const result = await service.build();
    expect(result.buy.sampleSize).toBe(2);
    expect(result.buy.winRate).toBeCloseTo(0.5);
    expect(result.buy.averagePnl).toBeCloseTo(3);
    expect(result.sell.sampleSize).toBe(1);
    expect(result.sell.winRate).toBe(1);
    expect(result.sell.averagePnl).toBe(6);
  });

  it('a trade with exactly zero profit does not count as a win', async () => {
    const account = await xtbAccount();
    await createRoundTrip(account.id, 'b1', 'BUY', 0);

    const result = await service.build();
    expect(result.buy.sampleSize).toBe(1);
    expect(result.buy.winRate).toBe(0);
  });

  // Audit finding (reconciliation session): win/loss must be classified by
  // NET P/L (profit + commission + swap), not the raw gross `profit` field —
  // confirmed against this account's own real EURUSD history, where several
  // gross-breakeven positions are net losers once a negative swap is
  // included. A gross winner small enough to be wiped out by swap must
  // count as a loss here, not a win.
  it('classifies win/loss by NET profit (including swap), not gross profit alone', async () => {
    const account = await xtbAccount();
    await createRoundTrip(account.id, 'b1', 'BUY', 1, { swap: -1.5 }); // gross +1, net -0.5
    await createRoundTrip(account.id, 'b2', 'BUY', 0, { swap: -2 }); // gross breakeven, net -2
    await createRoundTrip(account.id, 'b3', 'BUY', 5, { swap: -1 }); // gross +5, net +4 — still a real win

    const result = await service.build();
    expect(result.buy.sampleSize).toBe(3);
    expect(result.buy.winRate).toBeCloseTo(1 / 3); // only b3 is a net winner
    expect(result.buy.averagePnl).toBeCloseTo((-0.5 - 2 + 4) / 3);
  });

  it('confidence is LOW under 20 trades, MEDIUM from 20-99, HIGH from 100+', async () => {
    const account = await xtbAccount();
    for (let i = 0; i < 19; i++) {
      await createRoundTrip(account.id, `low-${i}`, 'BUY', 1);
    }
    expect((await service.build()).buy.confidence).toBe('LOW');

    await createRoundTrip(account.id, 'medium-boundary', 'BUY', 1); // 20th
    expect((await service.build()).buy.confidence).toBe('MEDIUM');

    for (let i = 0; i < 80; i++) {
      await createRoundTrip(account.id, `to-high-${i}`, 'BUY', 1); // 100th at i=79
    }
    expect((await service.build()).buy.confidence).toBe('HIGH');
  });

  // Reliability pass — reversed from the original "never mixes another
  // account's trades" expectation: this summary now deliberately represents
  // the trader's OWN pattern regardless of which account produced each
  // trade (the user's own framing — "it doesn't matter which account I
  // use... the data history of mine"), so trades from every account must be
  // combined, not isolated. Per-account isolation is still enforced
  // elsewhere (dashboard auth, positions, the EURUSD chart view's own
  // `getRoundTrips`) — only this AI-context summary aggregates across
  // accounts.
  it('combines trades from every account into one summary — this is the point of the account-independent lookup', async () => {
    const accountA = await xtbAccount();
    const accountB = await xtbAccount();
    await createRoundTrip(accountA.id, 'a1', 'BUY', 10);
    await createRoundTrip(accountB.id, 'b1', 'BUY', -10);

    const result = await service.build();
    expect(result.buy.sampleSize).toBe(2);
    expect(result.buy.averagePnl).toBe(0);
  });

  it('does not let two different accounts with the same position id collide into one round trip', async () => {
    // Both accounts use position id "shared" — a same-shaped IN/OUT pair on
    // each. If pairing keyed on positionId alone (not accountId:positionId),
    // account A's IN could wrongly pair with account B's OUT.
    const accountA = await xtbAccount();
    const accountB = await xtbAccount();
    await createRoundTrip(accountA.id, 'shared', 'BUY', 10);
    await createRoundTrip(accountB.id, 'shared', 'SELL', -20);

    const result = await service.build();
    expect(result.buy.sampleSize).toBe(1);
    expect(result.buy.averagePnl).toBe(10);
    expect(result.sell.sampleSize).toBe(1);
    expect(result.sell.averagePnl).toBe(-20);
  });

  it('ignores non-EURUSD symbols', async () => {
    const account = await xtbAccount();
    await prisma.trade.create({
      data: {
        accountId: account.id, platform: 'XTB', externalTradeId: 'g1-IN', positionId: 'g1',
        symbol: 'GBPUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1,
        price: 1.3, executedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.trade.create({
      data: {
        accountId: account.id, platform: 'XTB', externalTradeId: 'g1-OUT', positionId: 'g1',
        symbol: 'GBPUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1,
        price: 1.31, profit: 10, executedAt: new Date('2026-01-01T01:00:00Z'),
      },
    });

    const result = await service.build();
    expect(result.buy.sampleSize).toBe(0);
  });
});
