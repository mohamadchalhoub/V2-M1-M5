// Replay-fixture loader for analytics tests. Schema follows Phase 0 §23's
// { account, snapshots, trades, expected_analytics } shape, extended with
// `positions` (Phase 0's schema only anticipated deals, but position.metrics
// needs live open-position state) and `now` (the fixed evaluation instant
// that makes every "current" metric deterministic and reproducible).
//
// Every number in every fixture's `expectedCurrent`/`expectedBaselines` is
// hand-derived from the fixture's raw inputs — see the prose comment above
// each fixture's use in fixtures.spec.ts for the derivation. This loader
// only seeds Postgres and returns the accountId; it computes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createUser } from '../helpers/factories';

export interface FixtureSnapshot {
  capturedAt: string;
  balance: number;
  equity: number;
  margin?: number;
  freeMargin?: number;
  marginLevel?: number | null;
  profit?: number;
}

export interface FixtureTrade {
  externalTradeId: string;
  positionId?: string | null;
  symbol: string;
  side?: 'BUY' | 'SELL';
  dealEntry: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY';
  volume: number;
  price: number;
  commission?: number;
  swap?: number;
  profit?: number;
  executedAt: string;
}

export interface FixturePosition {
  externalPositionId: string;
  symbol: string;
  side?: 'BUY' | 'SELL';
  volume: number;
  openPrice?: number;
  status?: 'OPEN' | 'CLOSED';
  openedAt: string;
  profit?: number;
  swap?: number;
}

export interface AnalyticsFixture {
  description: string;
  account: {
    platform?: 'MT5' | 'XTB';
    currency?: string;
    tradingDayTimezone: string;
    tradingDayResetHour: number;
  };
  now: string;
  snapshots: FixtureSnapshot[];
  trades: FixtureTrade[];
  positions: FixturePosition[];
  baselineWindowDays?: number;
  expectedCurrent: Record<string, unknown>;
  expectedBaselines: Record<string, unknown>;
}

export function loadFixture(name: string): AnalyticsFixture {
  const path = join(__dirname, 'fixtures', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Seeds one user + trading account + snapshots + trades + positions from a fixture. Returns the accountId. */
export async function applyFixture(prisma: PrismaClient, fixture: AnalyticsFixture): Promise<string> {
  const user = await createUser(prisma);
  const account = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      platform: fixture.account.platform ?? 'MT5',
      externalAccountId: `fixture-${fixture.description}-${Math.random().toString(36).slice(2)}`,
      currency: fixture.account.currency ?? 'USD',
      tradingDayTimezone: fixture.account.tradingDayTimezone,
      tradingDayResetHour: fixture.account.tradingDayResetHour,
    },
  });

  for (const s of fixture.snapshots) {
    await prisma.accountSnapshot.create({
      data: {
        accountId: account.id,
        balance: s.balance,
        equity: s.equity,
        margin: s.margin ?? 0,
        freeMargin: s.freeMargin ?? s.balance,
        marginLevel: s.marginLevel ?? null,
        profit: s.profit ?? 0,
        capturedAt: new Date(s.capturedAt),
      },
    });
  }

  for (const t of fixture.trades) {
    await prisma.trade.create({
      data: {
        accountId: account.id,
        platform: fixture.account.platform ?? 'MT5',
        externalTradeId: t.externalTradeId,
        positionId: t.positionId ?? null,
        symbol: t.symbol,
        side: t.side ?? 'BUY',
        dealEntry: t.dealEntry,
        volume: t.volume,
        price: t.price,
        commission: t.commission ?? 0,
        swap: t.swap ?? 0,
        profit: t.profit ?? 0,
        executedAt: new Date(t.executedAt),
      },
    });
  }

  for (const p of fixture.positions) {
    await prisma.position.create({
      data: {
        accountId: account.id,
        platform: fixture.account.platform ?? 'MT5',
        externalPositionId: p.externalPositionId,
        symbol: p.symbol,
        side: p.side ?? 'BUY',
        volume: p.volume,
        openPrice: p.openPrice ?? 0,
        profit: p.profit ?? 0,
        swap: p.swap ?? 0,
        status: p.status ?? 'OPEN',
        openedAt: new Date(p.openedAt),
      },
    });
  }

  return account.id;
}
