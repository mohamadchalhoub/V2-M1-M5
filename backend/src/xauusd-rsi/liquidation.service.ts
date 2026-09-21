/**
 * Friday pre-weekend liquidation (spec §9.3).
 *
 * The single hard obligation in this strategy: every position and pending
 * order this application OWNS must be gone before Friday 23:30 Beirut.
 *
 * Design commitments, each of which the spec states explicitly:
 *
 * - **Starts at the 23:00 cutoff**, not at 23:29, so there is half an hour of
 *   retry and reconciliation headroom before the deadline.
 * - **Broker evidence only.** An item becomes `CONFIRMED_CLEARED` when it has
 *   disappeared from real broker-derived position data, never because a close
 *   request was submitted. A submitted request is `SUBMITTED`, nothing more.
 * - **Owned exposure only.** Foreign and manual XAUUSD positions are counted,
 *   displayed and reported separately, and never closed.
 * - **Never claims success it cannot prove.** A missed deadline is recorded as
 *   a durable `FAILED` row naming the remaining exposure, and reported as a
 *   miss — not smoothed over and not assumed resolved.
 * - **Runs regardless of pauses and kill switches.** Those govern new entries;
 *   they must never disable a protective closure (spec §10).
 * - **Idempotent and single-driver.** One row per ticket per deadline, and a
 *   close request is only created when no active one already exists for that
 *   ticket, so this worker and the protection-remediation worker can never
 *   submit duplicate closes for the same position.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoldExposureItem, RsiAccountStateService } from './account-state.service';
import { evaluateClockSchedule, evaluateLiquidationPhase, LiquidationPhase } from './schedule';
import { beirutLabel } from './time';
import { RSI_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS, RSI_LIQUIDATION_MAX_ATTEMPTS, RSI_SYMBOL } from './safety-constants';
import { describeOwnership } from './ownership';

export interface LiquidationCycleResult {
  phase: LiquidationPhase;
  detail: string;
  deadlineAtT: number | null;
  deadlineLabel: string | null;
  /** Owned items still not confirmed gone. */
  outstanding: Array<{ ticket: string; kind: string; status: string; attempts: number; lastError: string | null; ownership: string }>;
  /** Close requests created this cycle. */
  closeRequestsCreated: string[];
  /** Items confirmed gone by broker evidence this cycle. */
  confirmedCleared: string[];
  /** Foreign exposure, reported separately and never acted on. */
  foreignExposure: Array<{ ticket: string; description: string }>;
  /** True only when every OWNED item is confirmed gone. Never about the whole account. */
  ownedExposureFlat: boolean;
  notes: string[];
  /** Set when the deadline passed with owned exposure remaining. */
  criticalIncident: string | null;
}

@Injectable()
export class RsiLiquidationService {
  private readonly logger = new Logger(RsiLiquidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: RsiAccountStateService,
  ) {}

  /**
   * One liquidation cycle. Safe to call on every scheduler tick, at any time
   * of week: it does nothing but reconcile when liquidation is not due.
   */
  async runCycle(accountId: string, nowT: number = Date.now()): Promise<LiquidationCycleResult> {
    const clock = evaluateClockSchedule(nowT);
    const notes: string[] = [];
    const exposure = await this.accountState.resolveExposure(accountId);

    // Reconciliation runs FIRST and always — including when liquidation is not
    // due — so an item cleared while the process was off is recognised on the
    // next start rather than re-driven.
    const confirmedCleared = await this.reconcileCleared(accountId, exposure.ownedItems.map((i) => i.ticket));

    if (!clock.fridayLiquidationDue || clock.fridayDeadlineT === null) {
      return {
        phase: 'NOT_DUE',
        detail: 'Friday liquidation is not due.',
        deadlineAtT: clock.fridayDeadlineT,
        deadlineLabel: clock.fridayDeadlineT ? beirutLabel(clock.fridayDeadlineT) : null,
        outstanding: [],
        closeRequestsCreated: [],
        confirmedCleared,
        foreignExposure: exposure.foreignItems.map((i) => ({ ticket: i.ticket, description: i.description })),
        ownedExposureFlat: exposure.ownedExposureFlat,
        notes,
        criticalIncident: null,
      };
    }

    const deadlineAtT = clock.fridayDeadlineT;

    // Register every owned item against this weekend's deadline. Positions are
    // the real case; pending orders are registered the same way so that if one
    // is ever discovered it is tracked rather than silently ignored.
    for (const item of exposure.ownedItems) {
      if (item.kind === 'IN_FLIGHT_DECISION') {
        // An unsent or uncertain submission is retired/reconciled by the
        // decision path, not closed here — there is no ticket to close yet.
        notes.push(`owned in-flight decision ${item.ticket} is pending reconciliation, not closure (${item.description})`);
        continue;
      }
      await this.prisma.xauusdRsiLiquidationItem.upsert({
        where: { deadlineAt_ticket: { deadlineAt: new Date(deadlineAtT), ticket: item.ticket } },
        create: {
          accountId,
          symbol: RSI_SYMBOL,
          deadlineAt: new Date(deadlineAtT),
          kind: 'POSITION',
          ticket: item.ticket,
          side: item.side,
          volume: item.volume,
          magicNumber: item.magicNumber ?? 0,
          status: 'OUTSTANDING',
        },
        update: {},
      });
    }

    const closeRequestsCreated = await this.driveOutstanding(accountId, deadlineAtT, nowT, exposure.ownedItems, notes);

    const items = await this.prisma.xauusdRsiLiquidationItem.findMany({
      where: { accountId, deadlineAt: new Date(deadlineAtT) },
      orderBy: { createdAt: 'asc' },
    });
    const unresolved = items.filter((i) => i.status === 'OUTSTANDING' || i.status === 'SUBMITTED' || i.status === 'FAILED');

    const ownedFlat = exposure.ownedExposureFlat && unresolved.length === 0;
    const phaseInfo = evaluateLiquidationPhase({ utcMs: nowT, ownedExposureFlat: ownedFlat });

    let criticalIncident: string | null = null;
    if (phaseInfo.phase === 'DEADLINE_MISSED') {
      // Durably mark the miss so it survives a restart and can never be
      // mistaken for an in-progress run.
      await this.prisma.xauusdRsiLiquidationItem.updateMany({
        where: { accountId, deadlineAt: new Date(deadlineAtT), status: { in: ['OUTSTANDING', 'SUBMITTED'] } },
        data: { status: 'FAILED', lastError: 'Friday 23:30 Beirut closure deadline passed with this exposure still present.' },
      });
      const remaining = unresolved.map((i) => `${i.kind} ${i.ticket} (${describeOwnership(i.magicNumber)})`).join('; ');
      criticalIncident =
        `FRIDAY CLOSURE DEADLINE MISSED. The ${beirutLabel(deadlineAtT)} deadline has passed and owned XAUUSD exposure remains: ` +
        `${remaining || 'exposure present in broker data but not itemised'}. New entries remain disabled. ` +
        `This is reported as a miss — no position is assumed to have closed.`;
      this.logger.error(criticalIncident);
    }

    return {
      phase: phaseInfo.phase,
      detail: phaseInfo.detail,
      deadlineAtT,
      deadlineLabel: beirutLabel(deadlineAtT),
      outstanding: unresolved.map((i) => ({
        ticket: i.ticket,
        kind: i.kind,
        status: i.status,
        attempts: i.attempts,
        lastError: i.lastError,
        ownership: describeOwnership(i.magicNumber),
      })),
      closeRequestsCreated,
      confirmedCleared,
      foreignExposure: exposure.foreignItems.map((i) => ({ ticket: i.ticket, description: i.description })),
      ownedExposureFlat: ownedFlat,
      notes,
      criticalIncident,
    };
  }

  /**
   * Marks items that are genuinely gone from broker-derived data.
   *
   * `liveOwnedTickets` comes from `Position` rows, which the collector syncs
   * from real MT5 state. A ticket that is no longer there is gone as far as
   * the broker is concerned — that, and only that, is what clears an item.
   */
  private async reconcileCleared(accountId: string, liveOwnedTickets: string[]): Promise<string[]> {
    const active = await this.prisma.xauusdRsiLiquidationItem.findMany({
      where: { accountId, status: { in: ['OUTSTANDING', 'SUBMITTED'] } },
    });
    const cleared: string[] = [];
    for (const item of active) {
      if (liveOwnedTickets.includes(item.ticket)) continue;
      await this.prisma.xauusdRsiLiquidationItem.update({
        where: { id: item.id },
        data: { status: 'CONFIRMED_CLEARED', clearedAt: new Date() },
      });
      cleared.push(item.ticket);
      this.logger.log(`liquidation item ${item.ticket}: CONFIRMED_CLEARED — no longer present in broker position data`);
    }
    return cleared;
  }

  /**
   * Submits a close for each outstanding item, with bounded retry.
   *
   * A close request is created only when there is no active (`PENDING`/`SENT`)
   * `GoldCloseRequest` for that ticket already — which is what stops this
   * worker and the protection-remediation worker from both closing the same
   * position. The close infrastructure itself (`gold_close_requests` plus the
   * collector's existing close-request poll and broker-confirmed report) is
   * reused unchanged; only the reason for closing is new.
   */
  private async driveOutstanding(
    accountId: string,
    deadlineAtT: number,
    nowT: number,
    ownedItems: GoldExposureItem[],
    notes: string[],
  ): Promise<string[]> {
    const created: string[] = [];
    const items = await this.prisma.xauusdRsiLiquidationItem.findMany({
      where: { accountId, deadlineAt: new Date(deadlineAtT), status: { in: ['OUTSTANDING', 'SUBMITTED'] } },
    });

    for (const item of items) {
      if (item.kind === 'PENDING_ORDER') {
        // This strategy only ever submits market orders, so it cannot create
        // a broker-side pending order. If one is ever observed, it is recorded
        // and escalated rather than silently ignored — the collector has no
        // order-cancel capability, so this needs an operator.
        notes.push(
          `Owned PENDING_ORDER ${item.ticket} requires cancellation, which the collector cannot currently perform. ` +
            `Cancel it manually in the MT5 terminal before ${beirutLabel(deadlineAtT)}.`,
        );
        continue;
      }

      if (item.attempts >= RSI_LIQUIDATION_MAX_ATTEMPTS) {
        await this.prisma.xauusdRsiLiquidationItem.update({
          where: { id: item.id },
          data: { status: 'FAILED', lastError: `Exhausted ${RSI_LIQUIDATION_MAX_ATTEMPTS} close attempts without broker-confirmed closure.` },
        });
        notes.push(`liquidation item ${item.ticket}: attempts exhausted — escalated, not retried further`);
        continue;
      }

      // An in-flight attempt is given time to be confirmed before a retry, so
      // a slow broker response does not produce a second close of the same
      // position.
      if (item.status === 'SUBMITTED' && item.lastAttemptAt) {
        const sinceSeconds = (nowT - item.lastAttemptAt.getTime()) / 1000;
        if (sinceSeconds < RSI_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS) {
          notes.push(
            `liquidation item ${item.ticket}: a close attempt is already in flight (${sinceSeconds.toFixed(0)}s ago, ` +
              `waiting up to ${RSI_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS}s for broker confirmation) — not duplicating it`,
          );
          continue;
        }
      }

      const existingRequest = await this.prisma.goldCloseRequest.findFirst({
        where: { accountId, positionTicket: item.ticket, status: { in: ['PENDING', 'SENT'] } },
        orderBy: { requestedAt: 'desc' },
      });
      if (existingRequest) {
        await this.prisma.xauusdRsiLiquidationItem.update({
          where: { id: item.id },
          data: { status: 'SUBMITTED', lastAttemptAt: item.lastAttemptAt ?? new Date(nowT) },
        });
        notes.push(`liquidation item ${item.ticket}: a close request (${existingRequest.id}) is already in flight — not duplicating it`);
        continue;
      }

      const live = ownedItems.find((o) => o.ticket === item.ticket);
      const request = await this.prisma.goldCloseRequest.create({
        data: {
          accountId,
          symbol: RSI_SYMBOL,
          positionTicket: item.ticket,
          side: live?.side ?? item.side,
          volume: live?.volume ?? item.volume.toNumber(),
        },
      });
      await this.prisma.xauusdRsiLiquidationItem.update({
        where: { id: item.id },
        data: { status: 'SUBMITTED', attempts: item.attempts + 1, lastAttemptAt: new Date(nowT) },
      });
      created.push(request.id);
      this.logger.log(`Friday liquidation: close request ${request.id} created for owned position ${item.ticket} (attempt ${item.attempts + 1})`);
    }

    return created;
  }
}
