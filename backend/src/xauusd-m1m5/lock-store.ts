/**
 * The four post-loss directional locks (§6), with the DATABASE as their single
 * source of truth.
 *
 * ## Why this file exists
 *
 * The observation loop decided entries against an in-memory LockSet that it
 * created EMPTY at startup and never loaded. Locks, meanwhile, are activated in
 * the database -- by reconciliation, when a broker-confirmed losing closure is
 * applied. Nothing carried one to the other. So a lock could be active in the
 * database and invisible to every entry decision: after the first real trade
 * on the VPS lost at its stop and locked M1 SELL, nine further M1 SELL signals
 * reached the risk gate instead of being skipped, and were stopped only
 * because their size happened to exceed the per-trade risk cap.
 *
 * Unlocks had the mirror-image problem: an unlock observed in memory was never
 * written back, so the database lock would have stayed active forever.
 *
 * Now the loop loads the locks from the database every cycle before deciding,
 * and writes back any unlock it observes. The execution service independently
 * refuses a locked direction as well, so an entry into a locked direction needs
 * BOTH of these to fail.
 */
import type { PrismaClient } from '@prisma/client';
import { createLockSet, type LockRecord, type LockSet, type UnlockEvidence } from './locks';
import { directionalKey } from './safety-constants';
import type { Direction, Timeframe } from './spec';

function num(value: { toNumber(): number } | null): number | null {
  return value === null ? null : value.toNumber();
}

/** The database's locks for one account, as the LockSet the decision logic reads. */
export async function loadLockSet(prisma: PrismaClient, accountId: string, specHash: string): Promise<LockSet> {
  const rows = await prisma.xauusdM1M5DirectionalLock.findMany({ where: { accountId } });
  const base = createLockSet(specHash);
  const locks: Record<string, LockRecord> = { ...base.locks };

  for (const row of rows) {
    const timeframe = row.timeframe as Timeframe;
    const direction = row.direction as Direction;
    const lastUnlock: UnlockEvidence | null =
      row.unlockedAt && row.unlockCondition && row.unlockThreshold !== null && row.unlockRsi !== null
        ? {
            condition: row.unlockCondition as UnlockEvidence['condition'],
            threshold: row.unlockThreshold.toNumber(),
            rsi: row.unlockRsi.toNumber(),
            at: row.unlockedAt.getTime(),
          }
        : null;
    locks[directionalKey(timeframe, direction)] = {
      timeframe,
      direction,
      active: row.active,
      losingPositionId: row.losingPositionId,
      losingClosureEventId: row.losingClosureEventId,
      netRealized: num(row.netRealized),
      closedAt: row.closedAt ? row.closedAt.getTime() : null,
      activatedAt: row.activatedAt ? row.activatedAt.getTime() : null,
      rsiAtActivation: num(row.rsiAtActivation),
      lastUnlock,
    };
  }

  // Closure idempotency is enforced by the processed-closure table in the
  // database, not by this list, so it is not reconstructed here.
  return { specHash, locks, processedClosureEventIds: [] };
}

/**
 * Writes an observed unlock back to the database.
 *
 * Guarded exactly as §6.5 requires: only a lock that is still active, and only
 * by an observation strictly AFTER the lock was activated. An observation that
 * preceded the losing closure can never release the lock that closure caused.
 * Returns whether this call released it.
 */
export async function persistUnlock(
  prisma: PrismaClient,
  accountId: string,
  timeframe: Timeframe,
  direction: Direction,
  evidence: UnlockEvidence,
): Promise<boolean> {
  const at = new Date(evidence.at);
  const released = await prisma.xauusdM1M5DirectionalLock.updateMany({
    where: {
      accountId,
      timeframe,
      direction,
      active: true,
      OR: [{ activatedAt: null }, { activatedAt: { lt: at } }],
    },
    data: {
      active: false,
      unlockCondition: evidence.condition,
      unlockThreshold: evidence.threshold,
      unlockRsi: evidence.rsi,
      unlockedAt: at,
    },
  });
  return released.count > 0;
}
