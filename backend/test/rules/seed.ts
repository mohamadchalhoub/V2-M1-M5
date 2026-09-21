import { PrismaClient } from '@prisma/client';

let ticketCounter = 1;
function nextTicket(): string {
  ticketCounter += 1;
  return `T${ticketCounter}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

export async function seedSnapshot(
  prisma: PrismaClient,
  accountId: string,
  opts: { capturedAt: Date; balance: number; equity: number },
) {
  return prisma.accountSnapshot.create({
    data: {
      accountId,
      balance: opts.balance,
      equity: opts.equity,
      margin: 0,
      freeMargin: opts.balance,
      profit: opts.equity - opts.balance,
      capturedAt: opts.capturedAt,
    },
  });
}

/** A closing deal (OUT) — contributes to win/loss streaks, realized P/L, frequency counts. */
export async function seedClosingTrade(
  prisma: PrismaClient,
  accountId: string,
  opts: { executedAt: Date; profit: number; volume?: number; symbol?: string; positionId?: string },
) {
  return prisma.trade.create({
    data: {
      accountId,
      platform: 'MT5',
      externalTradeId: nextTicket(),
      positionId: opts.positionId ?? null,
      symbol: opts.symbol ?? 'EURUSD',
      side: 'BUY',
      dealEntry: 'OUT',
      volume: opts.volume ?? 0.1,
      price: 1.1,
      commission: 0,
      swap: 0,
      profit: opts.profit,
      executedAt: opts.executedAt,
    },
  });
}

/** An opening deal (IN) — feeds averagePositionVolume/maximumNormalPositionVolume baselines. */
export async function seedInDeal(
  prisma: PrismaClient,
  accountId: string,
  opts: { executedAt: Date; volume: number; symbol?: string },
) {
  return prisma.trade.create({
    data: {
      accountId,
      platform: 'MT5',
      externalTradeId: nextTicket(),
      symbol: opts.symbol ?? 'EURUSD',
      side: 'BUY',
      dealEntry: 'IN',
      volume: opts.volume,
      price: 1.1,
      commission: 0,
      swap: 0,
      profit: 0,
      executedAt: opts.executedAt,
    },
  });
}

export async function seedOpenPosition(
  prisma: PrismaClient,
  accountId: string,
  opts: { volume: number; openedAt: Date; symbol?: string },
) {
  return prisma.position.create({
    data: {
      accountId,
      platform: 'MT5',
      externalPositionId: nextTicket(),
      symbol: opts.symbol ?? 'GBPUSD',
      side: 'BUY',
      volume: opts.volume,
      openPrice: 1.25,
      profit: 0,
      swap: 0,
      status: 'OPEN',
      openedAt: opts.openedAt,
    },
  });
}
