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
import type { BrokerClosure, BrokerPosition, BrokerSnapshot } from './reconciliation.service';
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

/** MT5 DEAL_REASON_*, as the operator would name them. */
function closureReasonLabel(rawPayload: unknown): string {
  const reason =
    typeof rawPayload === 'object' && rawPayload !== null ? (rawPayload as Record<string, unknown>).reason : undefined;
  switch (reason) {
    case 4:
      return 'Stop loss hit';
    case 5:
      return 'Take profit hit';
    case 6:
      return 'Stop-out';
    case 3:
      return 'Closed by an expert/API request';
    case 0:
    case 1:
    case 2:
      return 'Closed manually';
    default:
      return 'Closed';
  }
}

function dealFee(rawPayload: unknown): number {
  if (typeof rawPayload !== 'object' || rawPayload === null) return 0;
  const fee = Number((rawPayload as Record<string, unknown>).fee);
  return Number.isFinite(fee) ? fee : 0;
}

/**
 * Closures for this strategy's FILLED positions that are no longer open.
 *
 * These used to be missing entirely: the snapshot always reported an empty
 * closure list, and reconciliation frees a filled slot ONLY from a closure. So
 * a position that hit its stop or target left its timeframe occupied forever,
 * and a loss never armed its post-loss lock. Found with the first real trade
 * open, before it closed.
 *
 * Each closure is built from two sources, each used for what it is
 * authoritative about:
 *
 *   the DECISION  ticket, direction and magic number -- ours by construction,
 *                 recorded when the order was placed
 *   the DEALS     what the broker actually did: volume in and out, realised
 *                 P/L with commission, swap and fees, when, and why
 *
 * `dealsComplete` is true only when the opening leg is present AND the closing
 * legs account for its whole volume. Until the collector's trade sync delivers
 * them, the closure is reported INCOMPLETE and reconciliation leaves the slot
 * held and takes no lock decision -- it waits a pass rather than guessing.
 * Concluding a closure from a partial deal picture is the one thing this must
 * never do: it would classify an unknown result.
 */
export async function buildClosures(
  prisma: PrismaClient,
  accountId: string,
  openTickets: ReadonlySet<string>,
): Promise<BrokerClosure[]> {
  const filled = await prisma.xauusdM1M5SlotLock.findMany({
    where: { accountId, state: 'FILLED' },
    include: { decision: { select: { ticket: true, direction: true, magicNumber: true } } },
  });

  const closures: BrokerClosure[] = [];
  for (const slot of filled) {
    const decision = slot.decision;
    if (!decision?.ticket || decision.magicNumber === null) continue;
    const ticket = decision.ticket.toString();
    // Still open: nothing to conclude.
    if (openTickets.has(ticket)) continue;

    const deals = await prisma.trade.findMany({
      where: { accountId, positionId: ticket },
      orderBy: { executedAt: 'asc' },
    });
    const opening = deals.filter((d) => d.dealEntry === 'IN' || d.dealEntry === 'INOUT');
    const closing = deals.filter((d) => d.dealEntry === 'OUT' || d.dealEntry === 'OUT_BY' || d.dealEntry === 'INOUT');
    const openedVolume = opening.reduce((sum, d) => sum + Number(d.volume), 0);
    const closedVolume = closing.reduce((sum, d) => sum + Number(d.volume), 0);
    const dealsComplete = openedVolume > 0 && closing.length > 0 && closedVolume + 1e-9 >= openedVolume;

    // To the cent. A break-even trade summing to -0.0000001 in floating point
    // must not read as a loss -- classification is strictly `< 0`, and a false
    // loss would lock that direction.
    const net = deals.reduce(
      (sum, d) => sum + Number(d.profit) + Number(d.commission) + Number(d.swap) + dealFee(d.rawPayload),
      0,
    );
    const lastClose = closing[closing.length - 1];

    closures.push({
      ticket,
      magicNumber: decision.magicNumber,
      direction: decision.direction as Direction,
      // `|| 0` turns a rounded -0 into 0, so a break-even trade is stored and
      // shown as 0.00 rather than -0.00.
      netRealized: Math.round(net * 100) / 100 || 0,
      dealsComplete,
      // Stable across passes, since it is part of the closure's idempotency
      // key: a repeated report must never re-apply a closure.
      closedAtMs: lastClose ? lastClose.executedAt.getTime() : 0,
      closureReason: lastClose ? closureReasonLabel(lastClose.rawPayload) : 'Not yet reported by the broker',
    });
  }
  return closures;
}

/**
 * The broker's open positions and this strategy's closures, as far as we can
 * tell. Closures are built only from a FRESH snapshot: from stale data, a
 * missing position could simply be one the collector has not reported yet.
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

  const closures = fresh
    ? await buildClosures(prisma, accountId, new Set(positions.map((p) => p.ticket)))
    : [];

  return {
    complete: fresh,
    positions,
    closures,
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
