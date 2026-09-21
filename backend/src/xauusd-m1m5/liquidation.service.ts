/**
 * Friday liquidation, wired to the broker and the database (§9.3).
 *
 * The pure selection and completion logic lives in `liquidation.ts`; this is
 * the part that talks to things. Keeping the decision of *what* to liquidate
 * separate from the act of liquidating it is what lets the scoping rule —
 * only this strategy's own positions — be tested exhaustively without a
 * broker.
 *
 * ## What "done" means here
 *
 * Not "we sent the close requests". §9.3 is explicit that a submitted close
 * request is not proof of closure, and it is the single easiest way for a
 * liquidation routine to lie. Completion is established by re-querying the
 * broker and finding zero owned exposure — so this service always finishes by
 * asking, never by counting what it sent.
 *
 * ## Why it refuses to widen its own scope
 *
 * Every item acted on comes from `planLiquidation`, which filters by magic
 * number and returns everything else as `excluded`. This service never
 * queries "all open positions and close them"; it closes a list it was handed
 * and reports what it deliberately left alone. On a host where another system
 * is trading the same symbol on a Friday evening, that distinction is the
 * whole safety property.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  evaluateCompletion,
  nextAttempt,
  planLiquidation,
  type AttemptState,
  type BrokerItem,
  type LiquidationTarget,
  type LiquidationVerdict,
} from './liquidation';
import { evaluateClockSchedule } from './schedule';

/** What the broker side must provide. Injected, so this tests without one. */
export interface LiquidationBrokerPort {
  /** A fresh snapshot of open positions and pending orders. Null when unreadable. */
  snapshot(): Promise<readonly BrokerItem[] | null>;
  /** Requests a close. Returning ok means ACCEPTED, never CONFIRMED CLOSED. */
  close(target: LiquidationTarget): Promise<{ accepted: boolean; error?: string }>;
  /** Requests cancellation of a pending order. Same caveat. */
  cancel(target: LiquidationTarget): Promise<{ accepted: boolean; error?: string }>;
}

export interface LiquidationRunResult {
  readonly verdict: LiquidationVerdict;
  readonly attempted: readonly string[];
  readonly escalated: readonly string[];
  readonly excluded: readonly { ticket: string; reason: string }[];
  readonly detail: string;
}

@Injectable()
export class M1M5LiquidationService {
  private readonly logger = new Logger(M1M5LiquidationService.name);

  /** Per-ticket attempt bookkeeping, for bounded retry within a run. */
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject('M1M5_LIQUIDATION_BROKER') private readonly broker: LiquidationBrokerPort,
  ) {}

  /**
   * One liquidation pass. Called repeatedly by the scheduler between the
   * Friday cutoff and the deadline, and again on startup during a weekend so
   * a missed timer callback cannot leave exposure unattended.
   */
  async runOnce(nowMs: number): Promise<LiquidationRunResult> {
    const clock = evaluateClockSchedule(nowMs);

    if (!clock.fridayLiquidationDue) {
      return {
        verdict: { status: 'NOT_DUE', remainingOwned: 0, detail: 'Friday liquidation is not due.' },
        attempted: [],
        escalated: [],
        excluded: [],
        detail: 'Not due.',
      };
    }

    // --- Always start from a fresh broker snapshot. Anything else risks
    // acting on a stale view of what is actually open.
    const snapshot = await this.broker.snapshot();
    if (snapshot === null) {
      const verdict = evaluateCompletion({
        liquidationDue: true,
        deadlinePassed: clock.fridayDeadlinePassed,
        brokerSnapshot: null,
      });
      this.logger.error(verdict.detail);
      return { verdict, attempted: [], escalated: [], excluded: [], detail: verdict.detail };
    }

    const plan = planLiquidation(snapshot);

    // Nothing of ours open: confirmed flat, from the broker's own view.
    if (plan.targets.length === 0) {
      const verdict = evaluateCompletion({
        liquidationDue: true,
        deadlinePassed: clock.fridayDeadlinePassed,
        brokerSnapshot: snapshot,
      });
      this.attempts.clear();
      return {
        verdict,
        attempted: [],
        escalated: [],
        excluded: [...plan.excluded],
        detail: verdict.detail,
      };
    }

    const attempted: string[] = [];
    const escalated: string[] = [];

    for (const target of plan.targets) {
      const state = this.attempts.get(target.ticket) ?? { ticket: target.ticket, attempts: 0, lastAttemptAtMs: null };
      const decision = nextAttempt(state, nowMs);

      if (decision.decision === 'ESCALATE') {
        escalated.push(target.ticket);
        this.logger.error(decision.detail);
        continue;
      }
      if (decision.decision === 'WAIT') {
        this.logger.log(decision.detail);
        continue;
      }

      const result =
        target.kind === 'PENDING_ORDER' ? await this.broker.cancel(target) : await this.broker.close(target);

      this.attempts.set(target.ticket, {
        ticket: target.ticket,
        attempts: state.attempts + 1,
        lastAttemptAtMs: nowMs,
      });
      attempted.push(target.ticket);

      this.logger.log(
        result.accepted
          ? `${target.timeframe} ${target.kind} ${target.ticket}: close/cancel ACCEPTED (not yet confirmed closed).`
          : `${target.timeframe} ${target.kind} ${target.ticket}: request refused - ${result.error ?? 'no reason given'}.`,
      );
    }

    // --- Re-query. A request accepted is not a position closed, so the
    // verdict comes from a second look rather than from what we just sent.
    //
    // The deadline is judged against the SAME explicit evaluation instant the
    // rest of this pass used, not a fresh Date.now(). §10 requires an explicit
    // server evaluation time, and reading the clock again mid-function would
    // make the same inputs produce different verdicts -- untestable, and
    // capable of reporting a missed deadline for a pass that began before it.
    // The scheduler calls this repeatedly, so a deadline that passes during a
    // pass is caught by the next one, with its own fresh instant.
    const after = await this.broker.snapshot();
    const verdict = evaluateCompletion({
      liquidationDue: true,
      deadlinePassed: clock.fridayDeadlinePassed,
      brokerSnapshot: after,
    });

    if (verdict.status === 'DEADLINE_MISSED') {
      this.logger.error(verdict.detail);
    }
    if (verdict.status === 'CONFIRMED_FLAT') {
      this.attempts.clear();
    }

    return {
      verdict,
      attempted,
      escalated,
      excluded: [...plan.excluded],
      detail: verdict.detail,
    };
  }

  /**
   * Whether new entries must stay blocked because liquidation is unresolved.
   *
   * Deliberately conservative: anything other than a broker-confirmed flat
   * state blocks. §9.3 requires entries to stay blocked through an outage,
   * and "we could not read broker state" is an outage, not an all-clear.
   */
  entriesBlockedByLiquidation(verdict: LiquidationVerdict): string | null {
    if (verdict.status === 'NOT_DUE' || verdict.status === 'CONFIRMED_FLAT') return null;
    return `Friday liquidation is unresolved (${verdict.status}). ${verdict.detail}`;
  }
}
