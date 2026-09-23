import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DailyReportService } from '../../src/telegram-engine/daily-report.service';
import type { TelegramEngineNotificationService } from '../../src/telegram-engine/notifications/notification.service';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
let accountId: string;
let seq = 0;

const sent: { key: string; text: string }[] = [];
const notifier = {
  notify: async (_e: string, key: string, text: string) => {
    sent.push({ key, text });
  },
} as unknown as TelegramEngineNotificationService;

async function deal(positionId: string, entry: 'IN' | 'OUT', magic: number, profit: number, at: Date) {
  seq += 1;
  await prisma.trade.create({
    data: {
      accountId,
      platform: 'MT5',
      externalTradeId: String(seq),
      positionId,
      symbol: 'XAUUSD',
      side: 'BUY',
      dealEntry: entry,
      volume: 0.01,
      price: 4300,
      profit,
      commission: 0,
      swap: 0,
      executedAt: at,
      rawPayload: { magic },
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  sent.length = 0;
  const user = await createUser(prisma);
  accountId = (await createTradingAccount(prisma, user.id)).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the daily report from recorded broker deals', () => {
  it('counts each closed position once, by engine and frame, within the Beirut day', async () => {
    const inDay = new Date('2026-09-23T10:00:00Z');
    // Engine A M1 win; the broker's TP close carries magic 0.
    await deal('p1', 'IN', 262610200, 0, new Date('2026-09-23T09:00:00Z'));
    await deal('p1', 'OUT', 0, 5, inDay);
    // Engine A M5 loss.
    await deal('p2', 'IN', 262610201, 0, new Date('2026-09-23T09:00:00Z'));
    await deal('p2', 'OUT', 262610201, -3, inDay);
    // Engine B win.
    await deal('p3', 'IN', 262610210, 0, new Date('2026-09-23T09:00:00Z'));
    await deal('p3', 'OUT', 262610210, 0.24, inDay);
    // Closed the NEXT Beirut day (22:00Z = 01:00 on the 24th): not counted.
    await deal('p4', 'IN', 262610210, 0, new Date('2026-09-23T20:00:00Z'));
    await deal('p4', 'OUT', 262610210, 9, new Date('2026-09-23T22:00:00Z'));

    const report = await new DailyReportService(prisma as never, notifier).build(accountId, '2026-09-23');

    expect(report.engineAM1).toMatchObject({ wins: 1, losses: 0 });
    expect(report.engineAM5).toMatchObject({ wins: 0, losses: 1 });
    expect(report.engineB).toMatchObject({ wins: 1, losses: 0 });
    expect(report.total).toMatchObject({ wins: 2, losses: 1 });

    // Per-order detail comes from the opening and closing deals.
    const m1 = report.positions.find((p) => p.attribution.timeframe === 'M1')!;
    expect(m1.side).toBe('BUY');
    expect(m1.openPrice).toBe(4300);
    expect(m1.closedAtMs).toBe(inDay.getTime());
  });

  it("sends yesterday's report, keyed by date so it goes out once per day", async () => {
    // 00:05 on the 24th Beirut -> reports the 23rd.
    await new DailyReportService(prisma as never, notifier).runOnce(accountId, Date.UTC(2026, 8, 23, 21, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(`daily-report:${accountId}:2026-09-23`);
    expect(sent[0].text).toContain('DAILY REPORT — 2026-09-23');
  });
});
