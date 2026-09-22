/**
 * Building a broker snapshot out of what the collector last pushed.
 *
 * Reconciliation and liquidation both need to know "what does the broker
 * actually hold right now". The backend cannot ask MetaTrader directly — the
 * terminal lives in the collector's container — so the answer is assembled
 * from the positions and deals the collector stored on its last cycle.
 *
 * ## The completeness flag is the whole safety property
 *
 * `BrokerSnapshot.complete` decides whether a missing position may be treated
 * as a CLOSED position. Get that wrong and the consequences are severe in both
 * directions: conclude closure from a stale snapshot and the strategy records
 * a phantom loss, activates a post-loss lock and frees a slot that still holds
 * a live position; refuse to ever conclude it and an UNKNOWN order stays
 * UNKNOWN forever with its timeframe held.
 *
 * So completeness here is not "the query returned rows". It is "the collector
 * wrote this data recently enough that absence means absence". The account
 * snapshot is written on the same collector cycle as the positions, so its age
 * is a direct proxy for how fresh the position data is — and if the collector
 * has been down for ten minutes, every position it last saw is ten minutes
 * stale and nothing may be concluded from one being missing.
 *
 * ## Magic numbers live in the raw payload
 *
 * The shared `positions` table has no magic-number column; it carries the raw
 * MT5 record instead. Ownership therefore comes out of `rawPayload`, and a
 * record without a readable magic is reported as `magicNumber: null`, which
 * `isOwnedByThisApplication` treats as NOT ours. That is the right default on
 * a host where another bot trades the same symbol: an unattributable position
 * is never adopted.
 */
import { PrismaClient } from '@prisma/client';
import type { BrokerPosition, BrokerSnapshot } from './reconciliation.service';
import type { BrokerItem } from './liquidation';
import { V2_SYMBOL } from './safety-constants';
import type { Direction } from './spec';

/**
 * How stale the collector's data may be before absence stops meaning absence.
 *
 * The collector's main loop runs on a poll interval of a few seconds, so a
 * minute is many missed cycles rather than ordinary jitter. Chosen to be
 * comfortably longer than one cycle and comfortably shorter than the time it
 * would take for a genuinely closed position to matter.
 */
export const SNAPSHOT_MAX_AGE_MS = 60_000;

/** Reads the MT5 magic number out of a stored raw position/deal record. */
export function extractMagic(rawPayload: unknown): number | null {
  if (typeof rawPayload !== 'object' || rawPayload === null) return null;
  const magic = (rawPayload as Record<string, unknown>).magic;
  if (typeof magic === 'number' && Number.isFinite(magic)) return magic;
  // Some payloads carry it as a string. Parsed, but never invented.
  if (typeof magic === 'string' && magic.trim() !== '') {
    const parsed = Number(magic);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The broker's open positions and recent closures, as far as we can tell.
 *
 * `closures` is left empty here on purpose. A closure must be concluded from a
 * COMPLETE deal history for that position — every IN and OUT leg, including
 * commission and swap — and `reconciliation.service` already refuses to act on
 * `dealsComplete: false`. Assembling a partial deal picture and labelling it
 * complete would be the single most damaging thing this file could do, so it
 * reports open positions only and lets reconciliation resolve UNKNOWNs by
 * their absence rather than by a half-built closure record.
 */
export async function buildBrokerSnapshot(
  prisma: PrismaClient,
  accountId: string,
  nowMs: number,
): Promise<BrokerSnapshot> {
  const latest = await prisma.accountSnapshot.findFirst({
    where: { accountId },
    orderBy: { capturedAt: 'desc' },
    select: { capturedAt: true },
  });

  const capturedAtMs = latest ? latest.capturedAt.getTime() : 0;
  const fresh = capturedAtMs > 0 && nowMs - capturedAtMs <= SNAPSHOT_MAX_AGE_MS;

  const rows = await prisma.position.findMany({
    where: { accountId, symbol: V2_SYMBOL, status: 'OPEN' },
  });

  const positions: BrokerPosition[] = rows.map((row) => ({
    ticket: row.externalPositionId,
    magicNumber: extractMagic(row.rawPayload),
    symbol: row.symbol,
    direction: (row.side === 'BUY' ? 'BUY' : 'SELL') as Direction,
    volume: Number(row.volume),
    openPrice: Number(row.openPrice),
    stopLoss: row.stopLoss === null ? null : Number(row.stopLoss),
    takeProfit: row.takeProfit === null ? null : Number(row.takeProfit),
  }));

  return {
    complete: fresh,
    positions,
    closures: [],
    capturedAtMs: capturedAtMs || nowMs,
  };
}

/**
 * The same stored positions, shaped for the liquidation planner.
 *
 * Returns null when the data is too stale to act on. Null propagates into
 * `planLiquidation` refusing to run, which is correct: closing positions based
 * on a stale list risks both missing one that is still open and trying to
 * close one that is already gone.
 *
 * Pending orders are not included. This strategy places market orders only, so
 * it never has a pending order to cancel; reporting an empty list is accurate
 * rather than a gap. If that ever changes, this is where they would come from.
 */
export async function buildLiquidationItems(
  prisma: PrismaClient,
  accountId: string,
  nowMs: number,
): Promise<readonly BrokerItem[] | null> {
  const snapshot = await buildBrokerSnapshot(prisma, accountId, nowMs);
  if (!snapshot.complete) return null;

  return snapshot.positions.map((p) => ({
    ticket: p.ticket,
    kind: 'POSITION' as const,
    symbol: p.symbol,
    magicNumber: p.magicNumber,
    volume: p.volume,
  }));
}
