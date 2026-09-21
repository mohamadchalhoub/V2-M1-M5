import { PrismaClient } from '@prisma/client';
import { tradingDayBoundaryContaining } from '../trading-day';
import { AccountSessionMetrics } from '../types/analytics.types';
import { decimalToNumber, round2, round4 } from '../util';

interface EquityAnchor {
  balance: number;
  equity: number;
  capturedAt: Date;
  margin?: number;
  freeMargin?: number;
  marginLevel?: number | null;
}

/** Latest snapshot with `capturedAt <= boundary`; `null` if none exists yet. */
export async function anchorSnapshot(
  prisma: PrismaClient,
  accountId: string,
  boundary: Date,
): Promise<EquityAnchor | null> {
  const row = await prisma.accountSnapshot.findFirst({
    where: { accountId, capturedAt: { lte: boundary } },
    orderBy: { capturedAt: 'desc' },
    select: { balance: true, equity: true, capturedAt: true },
  });
  if (!row) return null;
  return {
    balance: decimalToNumber(row.balance),
    equity: decimalToNumber(row.equity),
    capturedAt: row.capturedAt,
  };
}

async function latestSnapshot(prisma: PrismaClient, accountId: string): Promise<EquityAnchor | null> {
  const row = await prisma.accountSnapshot.findFirst({
    where: { accountId },
    orderBy: { capturedAt: 'desc' },
    select: { balance: true, equity: true, capturedAt: true, margin: true, freeMargin: true, marginLevel: true },
  });
  if (!row) return null;
  return {
    balance: decimalToNumber(row.balance),
    equity: decimalToNumber(row.equity),
    capturedAt: row.capturedAt,
    margin: decimalToNumber(row.margin),
    freeMargin: decimalToNumber(row.freeMargin),
    marginLevel: row.marginLevel === null ? null : decimalToNumber(row.marginLevel),
  };
}

async function allTimePeakEquity(prisma: PrismaClient, accountId: string): Promise<number | null> {
  const result = await prisma.accountSnapshot.aggregate({
    where: { accountId },
    _max: { equity: true },
  });
  return result._max.equity === null ? null : decimalToNumber(result._max.equity);
}

/**
 * Max drawdown over the account's entire snapshot history: for every row, the
 * running peak equity up to and including that row, minus that row's equity,
 * as a fraction of the running peak; then the max of that series. One SQL
 * window-function query (ANALYTICS_SPEC.md §2.1) rather than pulling every
 * snapshot into Node.
 */
async function maxDrawdownAllTime(prisma: PrismaClient, accountId: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ max_dd: string | null }>>`
    WITH running AS (
      SELECT
        equity,
        MAX(equity) OVER (ORDER BY captured_at ROWS UNBOUNDED PRECEDING) AS running_peak
      FROM account_snapshots
      WHERE account_id = ${accountId}
    )
    SELECT (MAX(
      CASE WHEN running_peak > 0 THEN (running_peak - equity) / running_peak ELSE 0 END
    ))::text AS max_dd
    FROM running;
  `;
  const value = rows[0]?.max_dd;
  return value === null || value === undefined ? null : Number(value);
}

export async function computeAccountSessionMetrics(
  prisma: PrismaClient,
  accountId: string,
  tz: string,
  resetHour: number,
  now: Date,
): Promise<AccountSessionMetrics> {
  const { start: tradingDayStart } = tradingDayBoundaryContaining(now, tz, resetHour);

  const [startAnchor, current, peakEquity, maxDrawdown] = await Promise.all([
    anchorSnapshot(prisma, accountId, tradingDayStart),
    latestSnapshot(prisma, accountId),
    allTimePeakEquity(prisma, accountId),
    maxDrawdownAllTime(prisma, accountId),
  ]);

  const startingBalance = startAnchor ? round2(startAnchor.balance) : null;
  const currentBalance = current ? round2(current.balance) : null;
  const currentEquity = current ? round2(current.equity) : null;

  const dailyPl =
    startAnchor && current ? round2(current.equity - startAnchor.equity) : null;
  const dailyProfit = dailyPl === null ? null : round2(Math.max(dailyPl, 0));
  const dailyLoss = dailyPl === null ? null : round2(Math.max(-dailyPl, 0));

  const drawdown =
    peakEquity !== null && current !== null && peakEquity > 0
      ? round4(Math.max(0, (peakEquity - current.equity) / peakEquity))
      : peakEquity !== null && current !== null
        ? 0
        : null;

  return {
    startingBalance,
    currentBalance,
    currentEquity,
    dailyPl,
    dailyProfit,
    dailyLoss,
    drawdown,
    maxDrawdown: maxDrawdown === null ? null : round4(maxDrawdown),
    margin: current?.margin === undefined ? null : round2(current.margin),
    freeMargin: current?.freeMargin === undefined ? null : round2(current.freeMargin),
    marginLevel: current?.marginLevel == null ? null : round2(current.marginLevel),
  };
}
