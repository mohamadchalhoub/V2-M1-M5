import { Prisma, PrismaClient } from '@prisma/client';

// Shared raw-SQL aggregate queries used by both metrics/ (all-time / live) and
// baselines/ (windowed) — one query definition per concept, an optional
// [start, end) range turns the same query into either. Net profit
// (profit + commission + swap) is computed in SQL so a single query returns
// every win/loss statistic exactly once; nothing here loads deal rows into
// Node (ANALYTICS_SPEC.md §3, performance note).

export interface DateRange {
  start: Date;
  end: Date;
}

function rangeClause(range?: DateRange) {
  return range
    ? Prisma.sql`AND executed_at >= ${range.start} AND executed_at < ${range.end}`
    : Prisma.empty;
}

export interface ClosingDealStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  averageWinningTrade: number | null;
  averageLosingTrade: number | null;
  largestWinningTrade: number | null;
  largestLosingTrade: number | null;
  totalRealizedPlGross: number;
  totalRealizedPl: number;
}

/** Win/loss statistics over closing deals (OUT/INOUT/OUT_BY) — ANALYTICS_SPEC.md §2.2/§3. */
export async function closingDealStats(
  prisma: PrismaClient,
  accountId: string,
  range?: DateRange,
): Promise<ClosingDealStats> {
  const rows = await prisma.$queryRaw<
    Array<{
      total_trades: number;
      winning_trades: number;
      losing_trades: number;
      avg_win: string | null;
      avg_loss: string | null;
      largest_win: string | null;
      largest_loss: string | null;
      total_gross: string;
      total_net: string;
    }>
  >`
    SELECT
      COUNT(*)::int AS total_trades,
      COUNT(*) FILTER (WHERE (profit + commission + swap) > 0)::int AS winning_trades,
      COUNT(*) FILTER (WHERE (profit + commission + swap) < 0)::int AS losing_trades,
      (AVG(profit + commission + swap) FILTER (WHERE (profit + commission + swap) > 0))::text AS avg_win,
      (AVG(profit + commission + swap) FILTER (WHERE (profit + commission + swap) < 0))::text AS avg_loss,
      (MAX(profit + commission + swap) FILTER (WHERE (profit + commission + swap) > 0))::text AS largest_win,
      (MIN(profit + commission + swap) FILTER (WHERE (profit + commission + swap) < 0))::text AS largest_loss,
      COALESCE(SUM(profit), 0)::text AS total_gross,
      COALESCE(SUM(profit + commission + swap), 0)::text AS total_net
    FROM trades
    WHERE account_id = ${accountId}
      AND deal_entry IN ('OUT', 'INOUT', 'OUT_BY')
      ${rangeClause(range)};
  `;

  const r = rows[0];
  return {
    totalTrades: r?.total_trades ?? 0,
    winningTrades: r?.winning_trades ?? 0,
    losingTrades: r?.losing_trades ?? 0,
    averageWinningTrade: r?.avg_win === null || r?.avg_win === undefined ? null : Number(r.avg_win),
    averageLosingTrade: r?.avg_loss === null || r?.avg_loss === undefined ? null : Number(r.avg_loss),
    largestWinningTrade:
      r?.largest_win === null || r?.largest_win === undefined ? null : Number(r.largest_win),
    largestLosingTrade:
      r?.largest_loss === null || r?.largest_loss === undefined ? null : Number(r.largest_loss),
    totalRealizedPlGross: r ? Number(r.total_gross) : 0,
    totalRealizedPl: r ? Number(r.total_net) : 0,
  };
}

export interface CommissionSwapTotals {
  totalCommission: number;
  totalSwap: number;
}

/** Realized commission/swap across ALL deals (IN and OUT), not just closing deals. */
export async function commissionSwapTotals(
  prisma: PrismaClient,
  accountId: string,
  range?: DateRange,
): Promise<CommissionSwapTotals> {
  const rows = await prisma.$queryRaw<Array<{ total_commission: string; total_swap: string }>>`
    SELECT
      COALESCE(SUM(commission), 0)::text AS total_commission,
      COALESCE(SUM(swap), 0)::text AS total_swap
    FROM trades
    WHERE account_id = ${accountId}
      ${rangeClause(range)};
  `;
  const r = rows[0];
  return {
    totalCommission: r ? Number(r.total_commission) : 0,
    totalSwap: r ? Number(r.total_swap) : 0,
  };
}

export interface InDealVolumeStats {
  average: number | null;
  max: number | null;
}

/** Opening-volume statistics from IN deals — see ANALYTICS_SPEC.md §2.3 for why IN deals, not `positions.volume`. */
export async function inDealVolumeStats(
  prisma: PrismaClient,
  accountId: string,
  range?: DateRange,
): Promise<InDealVolumeStats> {
  const rows = await prisma.$queryRaw<Array<{ avg_vol: string | null; max_vol: string | null }>>`
    SELECT (AVG(volume))::text AS avg_vol, (MAX(volume))::text AS max_vol
    FROM trades
    WHERE account_id = ${accountId}
      AND deal_entry = 'IN'
      ${rangeClause(range)};
  `;
  const r = rows[0];
  return {
    average: r?.avg_vol === null || r?.avg_vol === undefined ? null : Number(r.avg_vol),
    max: r?.max_vol === null || r?.max_vol === undefined ? null : Number(r.max_vol),
  };
}

export interface EquityAnchorAtBoundary {
  boundary: Date;
  equity: number | null;
}

/**
 * Resolves "equity at the latest snapshot at-or-before each boundary" for a
 * whole list of boundaries in one query (ANALYTICS_SPEC.md §3 implementation
 * note) via a LATERAL join, using the existing `(account_id, captured_at
 * DESC)` index — O(log n) per boundary regardless of total snapshot count.
 */
export async function anchorEquitiesAtBoundaries(
  prisma: PrismaClient,
  accountId: string,
  boundaries: Date[],
): Promise<EquityAnchorAtBoundary[]> {
  if (boundaries.length === 0) return [];

  const rows = await prisma.$queryRaw<Array<{ boundary: Date; equity: string | null }>>`
    SELECT b.boundary, (s.equity)::text AS equity
    FROM unnest(${boundaries}::timestamptz[]) AS b(boundary)
    LEFT JOIN LATERAL (
      SELECT equity FROM account_snapshots
      WHERE account_id = ${accountId} AND captured_at <= b.boundary
      ORDER BY captured_at DESC LIMIT 1
    ) s ON true
    ORDER BY b.boundary;
  `;

  return rows.map((r) => ({
    boundary: r.boundary,
    equity: r.equity === null ? null : Number(r.equity),
  }));
}

export interface FirstDataInstant {
  firstSnapshotAt: Date | null;
  firstTradeAt: Date | null;
}

/** Earliest known data point for the account, used to clip the baseline window for young accounts. */
export async function firstDataInstant(prisma: PrismaClient, accountId: string): Promise<FirstDataInstant> {
  const [snapshot, trade] = await Promise.all([
    prisma.accountSnapshot.findFirst({
      where: { accountId },
      orderBy: { capturedAt: 'asc' },
      select: { capturedAt: true },
    }),
    prisma.trade.findFirst({
      where: { accountId },
      orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
      select: { executedAt: true },
    }),
  ]);
  return {
    firstSnapshotAt: snapshot?.capturedAt ?? null,
    firstTradeAt: trade?.executedAt ?? null,
  };
}

/**
 * Average duration (minutes) of CLOSED positions whose last deal falls in
 * `range` (or all-time if omitted). Duration = last deal's executedAt minus
 * first deal's executedAt for that position_id, joined against `positions`
 * to find only ones the live sync has marked CLOSED. `position_id` is the
 * MT5 position ticket on both sides (collector/app/api_mapper.py maps
 * `externalPositionId`/`positionId` from the same `ticket`/`position_id`
 * field), so the join is a plain string-equality on that ticket, scoped by
 * account (and platform, for safety, though one account is one platform).
 */
export async function averagePositionDurationMinutes(
  prisma: PrismaClient,
  accountId: string,
  range?: DateRange,
): Promise<number | null> {
  const closingRangeClause = range
    ? Prisma.sql`AND last_at >= ${range.start} AND last_at < ${range.end}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{ avg_minutes: string | null }>>`
    WITH deal_span AS (
      SELECT position_id, MIN(executed_at) AS first_at, MAX(executed_at) AS last_at
      FROM trades
      WHERE account_id = ${accountId} AND position_id IS NOT NULL
      GROUP BY position_id
    )
    SELECT (AVG(EXTRACT(EPOCH FROM (ds.last_at - ds.first_at)) / 60.0))::text AS avg_minutes
    FROM deal_span ds
    JOIN positions p
      ON p.account_id = ${accountId}
     AND p.external_position_id = ds.position_id
     AND p.status = 'CLOSED'
    WHERE 1 = 1
      ${closingRangeClause};
  `;
  const value = rows[0]?.avg_minutes;
  return value === null || value === undefined ? null : Number(value);
}
