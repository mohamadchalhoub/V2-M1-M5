/**
 * Reconciling this strategy's records against broker reality (§7, §6.4, §10).
 *
 * Three jobs, all of which exist because **this application's records are a
 * claim about the world, and the broker is the world**:
 *
 * 1. **Uncertain submissions.** An order marked `UNKNOWN` may or may not be a
 *    live position. Until that is resolved its timeframe stays occupied, so
 *    resolving it is what frees the slot — and getting it wrong in the
 *    permissive direction opens a second position.
 * 2. **Closures.** A position that is gone from the broker has closed, and its
 *    net realized result decides whether a post-loss lock activates. Nothing
 *    else in this application is allowed to decide that.
 * 3. **Missing protection.** A filled position whose broker-side SL or TP is
 *    absent is unprotected, whatever this application's own record says.
 *
 * ## Ownership is checked first, every time
 *
 * Every broker position this sees is filtered by magic number before anything
 * else happens. A position belonging to another bot is counted for exposure
 * and never touched — not closed, not modified, not adopted, and never used to
 * activate one of this strategy's locks. That rule is enforced here rather
 * than assumed of callers, because this is where broker data enters.
 *
 * ## Absence is not closure
 *
 * A position missing from a broker snapshot has probably closed. It has also
 * possibly been omitted because the snapshot was partial, the connection
 * dropped mid-page, or the terminal was mid-reconnect. So a closure is only
 * concluded from a snapshot that is explicitly marked complete, and a
 * position that merely fails to appear in an incomplete snapshot is left
 * alone. Concluding otherwise would release a slot and, worse, could invent a
 * "closure" with no deals behind it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { M1M5OccupancyService } from './occupancy.service';
import { classifyClosure, type ClosureOutcome } from './locks';
import { isOwnedByThisApplication, timeframeForPosition } from './ownership';
import { V2_SL_USD, V2_TP_USD } from './safety-constants';
import type { Direction, Timeframe } from './spec';

/** One position as the broker reports it. */
export interface BrokerPosition {
  readonly ticket: string;
  readonly magicNumber: number | null;
  readonly symbol: string;
  readonly direction: Direction;
  readonly volume: number;
  readonly openPrice: number;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
}

/** A closed position's aggregated deal history, as the broker reports it. */
export interface BrokerClosure {
  readonly ticket: string;
  readonly magicNumber: number | null;
  readonly direction: Direction;
  /** Net across every attributable deal, including commission, swap and fees. */
  readonly netRealized: number;
  /** True only when every deal of this position has been retrieved. */
  readonly dealsComplete: boolean;
  readonly closedAtMs: number;
  readonly closureReason: string;
}

export interface BrokerSnapshot {
  /**
   * False when the snapshot may be partial — a dropped connection, a paged
   * query that did not finish, a terminal mid-reconnect. A closure is never
   * concluded from an incomplete snapshot.
   */
  readonly complete: boolean;
  readonly positions: readonly BrokerPosition[];
  readonly closures: readonly BrokerClosure[];
  readonly capturedAtMs: number;
}

export interface ProtectionIssue {
  readonly ticket: string;
  readonly timeframe: Timeframe;
  readonly missing: 'STOP_LOSS' | 'TAKE_PROFIT' | 'BOTH';
  readonly detail: string;
}

export interface ReconciliationResult {
  readonly uncertainResolved: number;
  readonly closuresApplied: number;
  readonly locksActivated: readonly string[];
  readonly protectionIssues: readonly ProtectionIssue[];
  readonly foreignPositionsSeen: number;
  readonly skipped: readonly string[];
}

@Injectable()
export class M1M5ReconciliationService {
  private readonly logger = new Logger(M1M5ReconciliationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly occupancy: M1M5OccupancyService,
  ) {}

  async reconcile(accountId: string, snapshot: BrokerSnapshot): Promise<ReconciliationResult> {
    const skipped: string[] = [];
    const locksActivated: string[] = [];

    // --- Ownership filter, before anything else touches this data. ---
    const ourPositions = snapshot.positions.filter((p) => isOwnedByThisApplication(p.magicNumber));
    const foreignPositionsSeen = snapshot.positions.length - ourPositions.length;

    const ourClosures = snapshot.closures.filter((c) => isOwnedByThisApplication(c.magicNumber));
    for (const c of snapshot.closures) {
      if (!isOwnedByThisApplication(c.magicNumber)) {
        // Named explicitly rather than silently dropped: a foreign loss must
        // never activate one of this strategy's locks, and saying so in the
        // result makes that visible rather than implicit.
        skipped.push(`closure ${c.ticket} (magic ${c.magicNumber}) belongs to another application; ignored`);
      }
    }

    // --- 1. Uncertain submissions. ---
    const uncertainResolved = await this.resolveUncertain(accountId, snapshot, ourPositions, skipped);

    // --- 2. Closures, which may activate a post-loss lock. ---
    let closuresApplied = 0;
    if (!snapshot.complete && ourClosures.length > 0) {
      skipped.push('broker snapshot is incomplete; closures were not applied this cycle');
    } else {
      for (const closure of ourClosures) {
        const timeframe = timeframeForPosition(closure.magicNumber);
        if (timeframe === null) continue;

        if (!closure.dealsComplete) {
          // §6.4: an unresolved result is not classified. The slot stays held
          // and no lock decision is taken until every deal is retrieved.
          skipped.push(`closure ${closure.ticket}: deals not fully retrieved, left unresolved`);
          continue;
        }

        const outcome: ClosureOutcome = {
          closureEventId: `${closure.ticket}:${closure.closedAtMs}`,
          positionId: closure.ticket,
          timeframe,
          direction: closure.direction,
          netRealized: closure.netRealized,
          fullyClosed: true,
          closedAt: closure.closedAtMs,
          closureReason: closure.closureReason,
          rsiAtClosure: null,
        };

        const applied = await this.occupancy.releaseOnClosure(accountId, outcome);
        if (applied.duplicate) continue;
        closuresApplied += 1;
        if (applied.lockActivated) {
          locksActivated.push(`${timeframe} ${closure.direction}`);
          this.logger.warn(
            `${timeframe} ${closure.direction} LOCKED after a broker-confirmed realized loss of ` +
              `${closure.netRealized} on ticket ${closure.ticket} (${closure.closureReason}).`,
          );
        }

        await this.prisma.xauusdM1M5Decision.updateMany({
          where: { accountId, ticket: BigInt(closure.ticket) },
          data: { orderStatus: 'FILLED', filledAt: new Date(closure.closedAtMs) },
        });
      }
    }

    // --- 3. Protection, on positions we actually own. ---
    const protectionIssues = this.checkProtection(ourPositions);

    return {
      uncertainResolved,
      closuresApplied,
      locksActivated,
      protectionIssues,
      foreignPositionsSeen,
      skipped,
    };
  }

  /**
   * Resolves orders whose fate was unknown.
   *
   * The asymmetry here is deliberate. An UNKNOWN order that DOES appear in
   * broker positions is definitely filled, so it is promoted. An UNKNOWN order
   * that does NOT appear is only treated as never-sent when the snapshot is
   * complete — otherwise absence proves nothing, and releasing the slot on
   * incomplete evidence is how a second position gets opened alongside a
   * position this application has forgotten about.
   */
  private async resolveUncertain(
    accountId: string,
    snapshot: BrokerSnapshot,
    ourPositions: readonly BrokerPosition[],
    skipped: string[],
  ): Promise<number> {
    const uncertain = await this.prisma.xauusdM1M5Decision.findMany({
      where: { accountId, orderStatus: 'UNKNOWN' },
    });
    if (uncertain.length === 0) return 0;

    const openTickets = new Set(ourPositions.map((p) => p.ticket));
    let resolved = 0;

    for (const row of uncertain) {
      const timeframe = row.timeframe as Timeframe;
      const ticket = row.ticket === null ? null : String(row.ticket);

      if (ticket !== null && openTickets.has(ticket)) {
        await this.prisma.xauusdM1M5Decision.update({
          where: { id: row.id },
          data: { orderStatus: 'FILLED', filledAt: row.filledAt ?? new Date(snapshot.capturedAtMs) },
        });
        await this.occupancy.advance(accountId, timeframe, 'FILLED');
        resolved += 1;
        continue;
      }

      if (!snapshot.complete) {
        skipped.push(
          `uncertain order ${row.id} (${timeframe}) left unresolved: the broker snapshot is incomplete, so its ` +
            'absence proves nothing and the timeframe stays occupied',
        );
        continue;
      }

      // Complete snapshot, no matching position, and a position opened by this
      // strategy would carry its magic number — so it was never filled.
      await this.prisma.xauusdM1M5Decision.update({
        where: { id: row.id },
        data: { orderStatus: 'FAILED', failureReason: 'not present in a complete broker snapshot; never filled' },
      });
      // Complete snapshot plus no matching position IS the evidence that
      // releaseUnsent's UNKNOWN guard is waiting for, so this uses the
      // reconciliation-specific release rather than weakening that guard.
      await this.occupancy.releaseAfterReconciliation(accountId, timeframe, row.id);
      resolved += 1;
    }

    return resolved;
  }

  /**
   * Positions missing broker-side protection (§7).
   *
   * Checked against what the BROKER reports, not against what this
   * application recorded when it submitted. A stop this application asked for
   * and the broker did not set is exactly the case that matters, and only the
   * broker's own view can reveal it.
   */
  private checkProtection(positions: readonly BrokerPosition[]): ProtectionIssue[] {
    const issues: ProtectionIssue[] = [];
    for (const p of positions) {
      const timeframe = timeframeForPosition(p.magicNumber);
      if (timeframe === null) continue;

      const noSl = p.stopLoss === null || p.stopLoss === 0;
      const noTp = p.takeProfit === null || p.takeProfit === 0;
      if (!noSl && !noTp) continue;

      const missing = noSl && noTp ? 'BOTH' : noSl ? 'STOP_LOSS' : 'TAKE_PROFIT';
      issues.push({
        ticket: p.ticket,
        timeframe,
        missing,
        detail:
          `${timeframe} ticket ${p.ticket} is missing ${missing.toLowerCase().replace('_', ' ')} at the broker. ` +
          `Expected $${V2_SL_USD} stop and $${V2_TP_USD} target from ${p.openPrice}. Remediation: one restoration ` +
          'attempt, then a fresh broker snapshot, then a scoped close if it is still missing.',
      });
    }
    return issues;
  }

  /**
   * Rebuilds occupancy from broker reality after a restart (§10, §13).
   *
   * Returns what each timeframe is holding according to the BROKER, which is
   * the authority. A restart must never adopt a position it did not open, so
   * this only ever reports positions carrying this strategy's own magic
   * numbers.
   */
  async reconstructOccupancy(
    snapshot: BrokerSnapshot,
  ): Promise<Record<Timeframe, { ticket: string; direction: Direction } | null>> {
    const byTimeframe: Record<Timeframe, { ticket: string; direction: Direction } | null> = { M1: null, M5: null };
    for (const p of snapshot.positions) {
      const timeframe = timeframeForPosition(p.magicNumber);
      if (timeframe === null) continue;
      byTimeframe[timeframe] = { ticket: p.ticket, direction: p.direction };
    }
    return byTimeframe;
  }
}
