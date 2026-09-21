/**
 * Atomic per-timeframe occupancy (§4).
 *
 * At most one active, pending or uncertain exposure per timeframe, so at most
 * two positions in total — one M1, one M5.
 *
 * ## Why a row, not a query
 *
 * "Is this timeframe free?" answered by a SELECT is a race: two workers can
 * both read "free" and both submit. Answered by an INSERT against a composite
 * primary key `(accountId, timeframe)`, it is not — the database rejects the
 * second writer, and the loser is told it lost rather than discovering later
 * that it opened a duplicate position.
 *
 * That is why `claim()` catches a unique-constraint violation and reports it
 * as a normal, expected outcome rather than as an error. Losing a race is not
 * a failure; it is the mechanism working.
 *
 * ## Why UNKNOWN counts as occupied
 *
 * An unreconciled submission may already be a position at the broker. Treating
 * that timeframe as free would risk a second one, so `UNKNOWN` holds the slot
 * until reconciliation resolves it. §7 requires uncertain submissions to be
 * reconciled rather than assumed, and this is the occupancy half of that.
 *
 * ## Ordering on closure
 *
 * §6.4 requires closure reconciliation, lock activation and slot release to be
 * coordinated so another worker cannot enter between them. `releaseOnClosure`
 * therefore does all three inside one transaction, in a fixed order: record
 * the closure as processed (idempotency), activate the post-loss lock if the
 * result was negative, and only then delete the slot row. A worker polling for
 * a free slot sees it become free only after the lock that should block it is
 * already in place.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient, type XauusdM1M5SlotState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { classifyClosure, unlockEvidenceFor, type ClosureOutcome } from './locks';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Direction, type Timeframe } from './spec';

/** Postgres unique-violation code, surfaced by Prisma as P2002. */
const UNIQUE_VIOLATION = 'P2002';

export type ClaimResult =
  | { claimed: true; timeframe: Timeframe }
  | { claimed: false; timeframe: Timeframe; reason: string };

export interface OccupancyRow {
  readonly timeframe: Timeframe;
  readonly state: XauusdM1M5SlotState;
  readonly decisionId: string;
  readonly claimedAt: Date;
}

@Injectable()
export class M1M5OccupancyService {
  private readonly logger = new Logger(M1M5OccupancyService.name);

  /**
   * Injected by the PrismaService token but typed as PrismaClient.
   *
   * Nest resolves providers by token, and this module provides PrismaService;
   * asking for a bare `PrismaClient` leaves Nest with a token it cannot
   * resolve, which fails at application boot rather than at compile time.
   * Typing the field as PrismaClient keeps this service constructible from a
   * plain client in tests, where the lifecycle hooks PrismaService adds are
   * not wanted.
   */
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /**
   * Atomically claims a timeframe for a decision.
   *
   * Returns `claimed: false` when the timeframe is already held — by an open
   * position, a pending submission, or an unreconciled one. The caller records
   * the signal as skipped with `TIMEFRAME_OCCUPIED` and consumes it; §4
   * forbids queueing it for when the slot frees.
   */
  async claim(accountId: string, timeframe: Timeframe, decisionId: string): Promise<ClaimResult> {
    try {
      await this.prisma.xauusdM1M5SlotLock.create({
        data: { accountId, timeframe, decisionId, state: 'PENDING' },
      });
      return { claimed: true, timeframe };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        // Expected outcome, not an error: another worker holds this timeframe.
        const holder = await this.current(accountId, timeframe);
        return {
          claimed: false,
          timeframe,
          reason: holder
            ? `${timeframe} is already held by decision ${holder.decisionId} (${holder.state}) since ` +
              `${holder.claimedAt.toISOString()}.`
            : `${timeframe} is already held by a concurrent claim.`,
        };
      }
      throw err;
    }
  }

  /** The row holding this timeframe, or null when it is free. */
  async current(accountId: string, timeframe: Timeframe): Promise<OccupancyRow | null> {
    const row = await this.prisma.xauusdM1M5SlotLock.findUnique({
      where: { accountId_timeframe: { accountId, timeframe } },
    });
    if (!row) return null;
    return {
      timeframe: row.timeframe as Timeframe,
      state: row.state,
      decisionId: row.decisionId,
      claimedAt: row.claimedAt,
    };
  }

  /** Both timeframes at once, for the dashboard and the decision gate. */
  async snapshot(accountId: string): Promise<Record<Timeframe, OccupancyRow | null>> {
    const rows = await this.prisma.xauusdM1M5SlotLock.findMany({ where: { accountId } });
    const byTimeframe: Record<Timeframe, OccupancyRow | null> = { M1: null, M5: null };
    for (const row of rows) {
      byTimeframe[row.timeframe as Timeframe] = {
        timeframe: row.timeframe as Timeframe,
        state: row.state,
        decisionId: row.decisionId,
        claimedAt: row.claimedAt,
      };
    }
    return byTimeframe;
  }

  /** Advances a held slot as its order progresses. Never frees it. */
  async advance(accountId: string, timeframe: Timeframe, state: XauusdM1M5SlotState): Promise<void> {
    await this.prisma.xauusdM1M5SlotLock.update({
      where: { accountId_timeframe: { accountId, timeframe } },
      data: { state },
    });
  }

  /**
   * Releases a slot whose order never reached the broker.
   *
   * Safe only for a decision that was definitively never sent — a pre-send
   * cancellation, a rejected submission with a broker-confirmed refusal. An
   * order whose fate is UNKNOWN must NOT be released this way: it may be a
   * live position, and freeing the slot would permit a second one.
   */
  async releaseUnsent(accountId: string, timeframe: Timeframe, decisionId: string): Promise<boolean> {
    const deleted = await this.prisma.xauusdM1M5SlotLock.deleteMany({
      where: { accountId, timeframe, decisionId, state: { in: ['PENDING', 'SENT'] } },
    });
    return deleted.count > 0;
  }

  /**
   * The full closure sequence: record, lock, release — in that order, in one
   * transaction (§6.4).
   *
   * Returns what happened, so the caller can notify accurately rather than
   * inferring. A duplicate closure report changes nothing and says so.
   */
  async releaseOnClosure(
    accountId: string,
    outcome: ClosureOutcome,
  ): Promise<{ duplicate: boolean; classification: string; lockActivated: boolean; slotReleased: boolean }> {
    const classification = classifyClosure(outcome);

    return this.prisma.$transaction(async (tx) => {
      // 1. Idempotency first. If this closure was already applied, nothing
      //    else may run — in particular, a repeated report must not reactivate
      //    a lock that has since been legitimately unlocked.
      try {
        await tx.xauusdM1M5ProcessedClosure.create({
          data: {
            accountId,
            closureEventId: outcome.closureEventId,
            positionId: outcome.positionId,
            classification,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
          this.logger.log(
            `Closure ${outcome.closureEventId} was already applied; ignoring the repeat report. ` +
              'A duplicate never reactivates a lock whose lifecycle has already been processed.',
          );
          return { duplicate: true, classification, lockActivated: false, slotReleased: false };
        }
        throw err;
      }

      // 2. An unresolved closure stops here. It has no trustworthy result, so
      //    no lock decision is taken AND the slot stays held — §6.4 forbids a
      //    new same-timeframe entry that could bypass the loss rule while the
      //    outcome is still unknown.
      if (classification === 'UNRESOLVED') {
        return { duplicate: false, classification, lockActivated: false, slotReleased: false };
      }

      // 3. Activate the post-loss lock BEFORE freeing the slot, so a worker
      //    that sees the slot become free already sees the lock that blocks it.
      let lockActivated = false;
      if (classification === 'LOSS') {
        await tx.xauusdM1M5DirectionalLock.upsert({
          where: {
            accountId_timeframe_direction: {
              accountId,
              timeframe: outcome.timeframe,
              direction: outcome.direction,
            },
          },
          create: {
            accountId,
            timeframe: outcome.timeframe,
            direction: outcome.direction,
            strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
            specHash: SPEC_HASH,
            active: true,
            losingPositionId: outcome.positionId,
            losingClosureEventId: outcome.closureEventId,
            netRealized: outcome.netRealized,
            closedAt: new Date(outcome.closedAt),
            activatedAt: new Date(outcome.closedAt),
            rsiAtActivation: outcome.rsiAtClosure,
          },
          update: {
            active: true,
            strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
            specHash: SPEC_HASH,
            losingPositionId: outcome.positionId,
            losingClosureEventId: outcome.closureEventId,
            netRealized: outcome.netRealized,
            closedAt: new Date(outcome.closedAt),
            activatedAt: new Date(outcome.closedAt),
            rsiAtActivation: outcome.rsiAtClosure,
            // A NEW lifecycle: the previous release is cleared rather than
            // left in place, where it would misrepresent the audit trail.
            unlockCondition: null,
            unlockThreshold: null,
            unlockRsi: null,
            unlockedAt: null,
          },
        });
        lockActivated = true;
      }

      // 4. Only now is the timeframe free.
      const released = await tx.xauusdM1M5SlotLock.deleteMany({
        where: { accountId, timeframe: outcome.timeframe },
      });

      return { duplicate: false, classification, lockActivated, slotReleased: released.count > 0 };
    });
  }

  /**
   * Applies an observation to this timeframe's two locks, releasing any whose
   * condition is met (§6.1, §6.2, §6.5).
   *
   * Returns the locks that were ACTIVE when the observation arrived, which is
   * what the decision gate must consult — §6.3: an observation that unlocks a
   * direction must not also submit that direction's entry.
   */
  async applyObservationToLocks(
    accountId: string,
    timeframe: Timeframe,
    rsi: number | null,
    at: Date,
    eligible: boolean,
  ): Promise<{ activeAtArrival: Direction[]; released: Direction[] }> {
    const rows = await this.prisma.xauusdM1M5DirectionalLock.findMany({
      where: { accountId, timeframe, active: true },
    });

    const activeAtArrival = rows.map((r) => r.direction as Direction);
    const released: Direction[] = [];

    if (!eligible || rsi === null || !Number.isFinite(rsi)) {
      return { activeAtArrival, released };
    }

    for (const row of rows) {
      // §6.5 ordering: an RSI observation that PRECEDES the losing closure can
      // never release the lock that closure caused.
      if (row.activatedAt !== null && at.getTime() <= row.activatedAt.getTime()) continue;

      const evidence = unlockEvidenceFor(row.direction as Direction, rsi, at.getTime());
      if (evidence === null) continue;

      await this.prisma.xauusdM1M5DirectionalLock.update({
        where: {
          accountId_timeframe_direction: { accountId, timeframe, direction: row.direction },
        },
        data: {
          active: false,
          unlockCondition: evidence.condition,
          unlockThreshold: evidence.threshold,
          unlockRsi: evidence.rsi,
          unlockedAt: at,
        },
      });
      released.push(row.direction as Direction);
    }

    return { activeAtArrival, released };
  }

  /** Whether a direction is locked right now, for the dashboard. */
  async isLocked(accountId: string, timeframe: Timeframe, direction: Direction): Promise<boolean> {
    const row = await this.prisma.xauusdM1M5DirectionalLock.findUnique({
      where: { accountId_timeframe_direction: { accountId, timeframe, direction } },
    });
    return row?.active === true;
  }
}
