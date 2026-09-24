/**
 * xauusd-sar-v1's single path from "the market moved" to "the broker has an
 * order" — session init, initial direction, and every reversal.
 *
 * Mirrors the ordering discipline `xauusd-m1m5/execution.service.ts` and
 * `telegram-engine/execution.service.ts` both use, for the same reason: what
 * happens if this process dies at each step must always be recoverable from
 * durable state, never from memory.
 *
 *   1. read the current session row                    — durable source of truth
 *   2. compute the pure decision (state-machine.ts)     — no side effects
 *   3. if it fires: write an XauusdSarOrderAttempt PENDING, atomically claim
 *      the session (state -> transitional), BEFORE the broker call
 *   4. hand to the broker
 *   5. record FILLED / FAILED / UNKNOWN; on FILLED, open the new cycle
 *
 * Nothing here approves a trade beyond the deterministic $0.50 rule itself.
 * There is no manual approval per order, and no AI/Telegram/dashboard input
 * — the same posture Engine A already had and Engine B already has.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { isSarSubmissionEnabled, sarEntriesBlockedByControls, getSarExecutionMode } from './controls';
import { SAR_MAGIC } from './safety-constants';
import {
  SPEC,
  SPEC_HASH,
  XAUUSD_SAR_STRATEGY_VERSION,
  isWithinDailyClose,
  localDateInZone,
  type SarDirection,
} from './spec';
import {
  applyTrailing,
  captureSessionReference,
  evaluateInitialDirection,
  initialSessionState,
  openInitialCycle,
  openReversalCycle,
  updateBuyTrailing,
  updateSellTrailing,
  type SarQuote,
  type SarSessionState,
  type SarState,
} from './state-machine';
import { currentSarVolume } from './volume-setting';
import {
  sarSessionInitializedMessage,
  sarInitialTriggerMessage,
  sarReversalMessage,
  sarUnknownMessage,
  sarDailyClosedMessage,
} from './notifications';
import { TelegramEngineNotificationService } from '../telegram-engine/notifications/notification.service';

export interface SarQuoteInput extends SarQuote {
  readonly ageSeconds: number;
  readonly fresh: boolean;
}

export interface SarSubmitRequest {
  readonly accountId: string;
  readonly cycleId: string;
  readonly kind: 'INITIAL' | 'REVERSAL';
  readonly direction: SarDirection;
  readonly volumeLots: number;
  readonly magicNumber: number;
  readonly idempotencyTag: string;
  /** Present only for a REVERSAL: the ticket of the position being closed. */
  readonly closingTicket: string | null;
}

export interface SarSubmitResponse {
  readonly status: 'FILLED' | 'FAILED' | 'UNKNOWN' | 'QUEUED';
  readonly ticket?: string;
  readonly fillPrice?: number;
  /** For a REVERSAL: the actual fill price of the closed leg, as reported by the broker's close deal. */
  readonly closeFillPrice?: number;
  readonly error?: string;
}

export interface SarBrokerPort {
  submit(request: SarSubmitRequest): Promise<SarSubmitResponse>;
}

export interface SarTickResult {
  readonly action:
    | 'NONE'
    | 'SESSION_INITIALIZED'
    | 'INITIAL_ENTRY_SUBMITTED'
    | 'REVERSAL_SUBMITTED'
    | 'BLOCKED'
    | 'DAILY_CLOSED';
  readonly detail: string;
}

function sessionRowToState(row: {
  sessionDate: string;
  state: SarState;
  sessionReference: Prisma.Decimal | null;
  initialBuyTrigger: Prisma.Decimal | null;
  initialSellTrigger: Prisma.Decimal | null;
  referenceCapturedAt: Date | null;
  cycleId: string | null;
  direction: SarDirection | null;
  entryFillPrice: Prisma.Decimal | null;
  extremeSinceEntry: Prisma.Decimal | null;
  reversalLevel: Prisma.Decimal | null;
  brokerTicket: string | null;
}): SarSessionState {
  return {
    sessionDate: row.sessionDate,
    state: row.state,
    sessionReference: row.sessionReference === null ? null : Number(row.sessionReference),
    initialBuyTrigger: row.initialBuyTrigger === null ? null : Number(row.initialBuyTrigger),
    initialSellTrigger: row.initialSellTrigger === null ? null : Number(row.initialSellTrigger),
    referenceCapturedAtMs: row.referenceCapturedAt?.getTime() ?? null,
    cycleId: row.cycleId,
    direction: row.direction,
    entryFillPrice: row.entryFillPrice === null ? null : Number(row.entryFillPrice),
    extremeSinceEntry: row.extremeSinceEntry === null ? null : Number(row.extremeSinceEntry),
    reversalLevel: row.reversalLevel === null ? null : Number(row.reversalLevel),
    brokerTicket: row.brokerTicket,
  };
}

@Injectable()
export class SarExecutionService {
  private readonly logger = new Logger(SarExecutionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject('SAR_BROKER_PORT') private readonly broker: SarBrokerPort,
    @Optional() private readonly notifier?: TelegramEngineNotificationService,
  ) {}

  protected now(): number {
    return Date.now();
  }

  private announce(text: string, dedupKey: string): void {
    void this.notifier?.notify('SAR_EVENT', dedupKey, text, 'TRADING').catch(() => undefined);
  }

  /**
   * The collector-facing claim: the oldest unclaimed `SENT` attempt, atomic
   * via the `claimedAt: null` guard in the WHERE clause — a concurrent
   * second poll updating zero rows is how a lost claim race is discovered,
   * never how a duplicate submission would be.
   */
  async claimNextOrderAttempt(accountId: string, nowMs: number) {
    const candidate = await this.prisma.xauusdSarOrderAttempt.findFirst({
      where: { accountId, status: 'SENT', claimedAt: null },
      orderBy: { requestedAt: 'asc' },
    });
    if (!candidate) return null;
    const claimed = await this.prisma.xauusdSarOrderAttempt.updateMany({
      where: { id: candidate.id, claimedAt: null },
      data: { claimedAt: new Date(nowMs) },
    });
    if (claimed.count === 0) return null;
    return candidate;
  }

  /** Ensures today's row exists; never overwrites an existing one (idempotent across restarts). */
  async ensureSession(accountId: string, nowMs: number): Promise<SarSessionState> {
    const date = localDateInZone(nowMs);
    const existing = await this.prisma.xauusdSarSession.findUnique({ where: { accountId } });
    if (existing && existing.sessionDate === date) return sessionRowToState(existing);
    if (existing && existing.sessionDate !== date && existing.state !== 'DAILY_CLOSED') {
      // A restart landed on a new calendar day while the prior day's row was
      // never closed — e.g. the process was down straight through 23:40.
      // Never silently roll a stale session into today: report it as still
      // needing a close, the caller (the scheduler) performs it explicitly.
      return sessionRowToState(existing);
    }
    const fresh = initialSessionState(date);
    const row = await this.prisma.xauusdSarSession.upsert({
      where: { accountId },
      create: { accountId, specHash: SPEC_HASH, sessionDate: date, state: 'WAIT_MARKET_OPEN' },
      update: { specHash: SPEC_HASH, sessionDate: date, state: 'WAIT_MARKET_OPEN' },
    });
    void row;
    return fresh;
  }

  /** 01:00 Beirut (or first fresh quote after it): captures the fixed session reference. */
  async initializeSession(accountId: string, quote: SarQuoteInput, nowMs: number): Promise<SarTickResult> {
    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId } });
    if (!row || row.state !== 'WAIT_MARKET_OPEN') {
      return { action: 'NONE', detail: 'session is not waiting for market open.' };
    }
    if (!quote.fresh) return { action: 'NONE', detail: `quote is stale (${quote.ageSeconds.toFixed(1)}s).` };

    const current = sessionRowToState(row);
    const next = captureSessionReference(current, quote, nowMs);
    const updated = await this.prisma.xauusdSarSession.updateMany({
      where: { accountId, state: 'WAIT_MARKET_OPEN' },
      data: {
        state: 'WAIT_INITIAL_DIRECTION',
        sessionReference: next.sessionReference,
        initialBuyTrigger: next.initialBuyTrigger,
        initialSellTrigger: next.initialSellTrigger,
        referenceCapturedAt: new Date(nowMs),
        referenceQuoteEvidence: { bid: quote.bid, ask: quote.ask },
      },
    });
    if (updated.count === 0) return { action: 'NONE', detail: 'lost the race to initialize; another worker did it.' };
    this.announce(
      sarSessionInitializedMessage({ reference: next.sessionReference!, buyTrigger: next.initialBuyTrigger!, sellTrigger: next.initialSellTrigger! }),
      `sar:session-init:${accountId}:${current.sessionDate}`,
    );
    return { action: 'SESSION_INITIALIZED', detail: `reference ${next.sessionReference}` };
  }

  /** The per-tick evaluation: initial direction discovery, or trailing + reversal while active. */
  async evaluateTick(accountId: string, quote: SarQuoteInput, nowMs: number): Promise<SarTickResult> {
    if (isWithinDailyClose(nowMs)) return { action: 'NONE', detail: 'within the daily close window.' };

    const blocked = sarEntriesBlockedByControls();
    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId } });
    if (!row) return { action: 'NONE', detail: 'no session row.' };
    if (row.state === 'REVERSAL_UNKNOWN') return { action: 'BLOCKED', detail: 'blocked on an UNKNOWN submission; reconciliation must resolve it.' };
    if (row.state === 'DAILY_CLOSED') return { action: 'NONE', detail: 'daily closed; waiting for the next session.' };
    if (!quote.fresh) return { action: 'NONE', detail: `quote is stale (${quote.ageSeconds.toFixed(1)}s).` };

    const current = sessionRowToState(row);

    if (current.state === 'WAIT_INITIAL_DIRECTION') {
      const outcome = evaluateInitialDirection(current, quote);
      if (outcome.direction === null) return { action: 'NONE', detail: 'no trigger reached.' };
      if (blocked) return { action: 'BLOCKED', detail: blocked };
      return this.submitAndResolve(accountId, current, outcome.direction, 'INITIAL', null, nowMs);
    }

    if (current.state === 'ACTIVE_BUY' || current.state === 'ACTIVE_SELL') {
      const update = current.state === 'ACTIVE_BUY' ? updateBuyTrailing(current, quote) : updateSellTrailing(current, quote);
      await this.prisma.xauusdSarSession.updateMany({
        where: { accountId, state: current.state },
        data: { extremeSinceEntry: update.extremeSinceEntry, reversalLevel: update.reversalLevel },
      });
      if (!update.reversalTriggered) return { action: 'NONE', detail: 'trailing updated, no reversal.' };
      // A REVERSAL is the strategy's own exit mechanism, not a new entry --
      // it must never be held back by the same gate that stops fresh
      // exposure. Blocking it here would leave a position open and
      // unmanaged, which is strictly worse than the reversal it is trying
      // to prevent.
      const newDirection: SarDirection = current.state === 'ACTIVE_BUY' ? 'SELL' : 'BUY';
      return this.submitAndResolve(
        accountId,
        applyTrailing(current, update),
        newDirection,
        'REVERSAL',
        current.brokerTicket,
        nowMs,
      );
    }

    return { action: 'NONE', detail: `no action for state ${current.state}.` };
  }

  private async submitAndResolve(
    accountId: string,
    session: SarSessionState,
    direction: SarDirection,
    kind: 'INITIAL' | 'REVERSAL',
    closingTicket: string | null,
    nowMs: number,
  ): Promise<SarTickResult> {
    const cycleId = randomUUID();
    const idempotencyTag = `SAR${cycleId.replace(/-/g, '').slice(0, 12)}`;
    const volume = (await currentSarVolume(this.prisma, accountId)) ?? null;
    if (volume === null) return { action: 'BLOCKED', detail: 'no volume configured for xauusd-sar.' };

    // Claim: the session row moves out of its current evaluable state BEFORE
    // the broker call, exactly like Engine A/B's PENDING-before-send pattern.
    const claim = await this.prisma.xauusdSarSession.updateMany({
      where: { accountId, state: session.state },
      data: { state: 'REVERSAL_UNKNOWN', unknownSince: new Date(nowMs) },
    });
    if (claim.count === 0) return { action: 'NONE', detail: 'lost the claim race for this tick.' };

    await this.prisma.xauusdSarOrderAttempt.create({
      data: { accountId, cycleId, idempotencyTag, kind, direction, volume, status: 'PENDING' },
    });

    let response: SarSubmitResponse;
    try {
      response = await this.broker.submit({
        accountId,
        cycleId,
        kind,
        direction,
        volumeLots: volume,
        magicNumber: SAR_MAGIC,
        idempotencyTag,
        closingTicket,
      });
    } catch (err) {
      response = { status: 'UNKNOWN', error: (err as Error).message };
    }

    if (response.status === 'QUEUED') {
      // A queueing port cannot yet say FILLED/FAILED. The session stays
      // REVERSAL_UNKNOWN (correctly — no exposure is confirmed either way)
      // until the collector reports back via resolveOrderAttempt().
      await this.prisma.xauusdSarOrderAttempt.update({
        where: { idempotencyTag },
        data: { status: 'SENT' },
      });
      return { action: kind === 'INITIAL' ? 'INITIAL_ENTRY_SUBMITTED' : 'REVERSAL_SUBMITTED', detail: 'queued to the collector.' };
    }

    return this.applyBrokerResult(
      { accountId, session, direction, kind, closingTicket, cycleId, idempotencyTag, volume, nowMs },
      response,
    );
  }

  /**
   * Everything that happens once a broker answer is KNOWN — FILLED, FAILED
   * or UNKNOWN — shared between the synchronous path (a test broker
   * answering inline) and the asynchronous production path, where the
   * queueing port always returns QUEUED here and the real answer arrives
   * later through `resolveOrderAttempt`.
   */
  private async applyBrokerResult(
    ctx: {
      accountId: string;
      session: SarSessionState;
      direction: SarDirection;
      kind: 'INITIAL' | 'REVERSAL';
      closingTicket: string | null;
      cycleId: string;
      idempotencyTag: string;
      volume: number;
      nowMs: number;
    },
    response: SarSubmitResponse,
  ): Promise<SarTickResult> {
    const { accountId, session, direction, kind, closingTicket, cycleId, idempotencyTag, volume, nowMs } = ctx;

    if (response.status === 'FILLED' && response.ticket && response.fillPrice !== undefined) {
      await this.prisma.xauusdSarOrderAttempt.update({
        where: { idempotencyTag },
        data: { status: 'FILLED', ticket: response.ticket, fillPrice: response.fillPrice, resolvedAt: new Date() },
      });
      const opened = kind === 'INITIAL' ? openInitialCycle(session, direction, response.fillPrice, cycleId, response.ticket) : openReversalCycle(session, direction, response.fillPrice, cycleId, response.ticket);
      await this.prisma.xauusdSarSession.update({
        where: { accountId },
        data: {
          state: opened.state,
          cycleId: opened.cycleId,
          direction: opened.direction,
          entryFillPrice: opened.entryFillPrice,
          extremeSinceEntry: opened.extremeSinceEntry,
          reversalLevel: opened.reversalLevel,
          brokerTicket: opened.brokerTicket,
          unknownSince: null,
        },
      });
      await this.prisma.xauusdSarCycle.create({
        data: { accountId, cycleId, direction, entryTicket: response.ticket, entryFillPrice: response.fillPrice, entryAt: new Date(nowMs) },
      });
      if (closingTicket) {
        // The real close price, when the collector reported it; the
        // trailing extreme is only ever a fallback for older attempts that
        // predate this field, never a substitute for the actual fill.
        const exitFillPrice = response.closeFillPrice ?? session.extremeSinceEntry ?? null;
        await this.prisma.xauusdSarCycle.updateMany({
          where: { accountId, entryTicket: closingTicket, exitAt: null },
          data: { exitTicket: closingTicket, exitFillPrice, exitAt: new Date(nowMs), exitReason: 'REVERSAL' },
        });
        this.announce(
          sarReversalMessage({ from: session.direction!, to: direction, fillPrice: response.fillPrice, volume }),
          `sar:reversal:${accountId}:${cycleId}`,
        );
      } else {
        this.announce(sarInitialTriggerMessage({ direction, fillPrice: response.fillPrice, volume }), `sar:initial:${accountId}:${cycleId}`);
      }
      return { action: kind === 'INITIAL' ? 'INITIAL_ENTRY_SUBMITTED' : 'REVERSAL_SUBMITTED', detail: `filled ${response.ticket} @ ${response.fillPrice}` };
    }

    if (response.status === 'FAILED') {
      await this.prisma.xauusdSarOrderAttempt.update({
        where: { idempotencyTag },
        data: { status: 'FAILED', failureReason: response.error ?? null, resolvedAt: new Date() },
      });
      // Broker-confirmed refusal: the prior state (whatever it was) still holds.
      await this.prisma.xauusdSarSession.update({
        where: { accountId },
        data: { state: session.state, unknownSince: null },
      });
      return { action: 'NONE', detail: `broker refused: ${response.error ?? 'no reason given'}` };
    }

    // UNKNOWN: leave state as REVERSAL_UNKNOWN. Reconciliation must resolve it.
    this.announce(sarUnknownMessage({ kind, direction, cycleId, error: response.error ?? 'lost or ambiguous broker answer' }), `sar:unknown:${accountId}:${cycleId}`);
    return { action: 'BLOCKED', detail: `broker answer UNKNOWN: ${response.error ?? 'no detail'}` };
  }

  /**
   * The production resolution path: the collector calls this (via the
   * collector-ingress controller) once it actually knows what happened to an
   * order this service earlier marked SENT. Idempotent — a resolved attempt
   * reported again is a no-op, since the collector's own retry behaviour is
   * not this service's concern to second-guess.
   */
  async resolveOrderAttempt(idempotencyTag: string, response: SarSubmitResponse, nowMs: number): Promise<SarTickResult | null> {
    const attempt = await this.prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag } });
    if (!attempt || attempt.status === 'FILLED' || attempt.status === 'FAILED') return null;

    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId: attempt.accountId } });
    if (!row) return null;

    const session = sessionRowToState(row);
    // The "closing ticket" for a REVERSAL is whatever ticket the session
    // still shows — the position this attempt is reversing out of.
    const closingTicket = attempt.kind === 'REVERSAL' ? row.brokerTicket : null;

    return this.applyBrokerResult(
      {
        accountId: attempt.accountId,
        session,
        direction: attempt.direction,
        kind: attempt.kind as 'INITIAL' | 'REVERSAL',
        closingTicket,
        cycleId: attempt.cycleId,
        idempotencyTag,
        volume: Number(attempt.volume),
        nowMs,
      },
      response,
    );
  }

  /** 23:40 Beirut: stop new exposure, flatten whatever is open, mark DAILY_CLOSED. Shutdown wins over a simultaneous reversal. */
  async closeForDay(accountId: string, nowMs: number): Promise<SarTickResult> {
    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId } });
    if (!row) return { action: 'NONE', detail: 'no session row.' };
    if (row.state === 'DAILY_CLOSED') return { action: 'NONE', detail: 'already closed.' };

    if (row.state === 'ACTIVE_BUY' || row.state === 'ACTIVE_SELL') {
      if (!row.brokerTicket) return { action: 'BLOCKED', detail: 'active state with no ticket — data defect, refusing to guess.' };
      const claim = await this.prisma.xauusdSarSession.updateMany({ where: { accountId, state: row.state }, data: { state: 'REVERSAL_UNKNOWN', unknownSince: new Date(nowMs) } });
      if (claim.count === 0) return { action: 'NONE', detail: 'lost the claim race.' };
      const response = await this.broker.submit({
        accountId,
        cycleId: row.cycleId ?? randomUUID(),
        kind: 'REVERSAL', // closing, not reversing — collector treats "closingTicket set, no reversal cycle to open" as a flatten.
        direction: row.direction === 'BUY' ? 'SELL' : 'BUY',
        volumeLots: Number(row.entryFillPrice ? await currentSarVolume(this.prisma, accountId) : 0) || (await currentSarVolume(this.prisma, accountId)) || 0,
        magicNumber: SAR_MAGIC,
        idempotencyTag: `SARCLOSE${(row.cycleId ?? randomUUID()).replace(/-/g, '').slice(0, 8)}`,
        closingTicket: row.brokerTicket,
      });
      if (response.status !== 'FILLED' && response.status !== 'QUEUED') {
        this.announce(sarUnknownMessage({ kind: 'REVERSAL', direction: row.direction!, cycleId: row.cycleId ?? '', error: `daily close failed: ${response.error ?? 'unknown'}` }), `sar:close-fail:${accountId}:${row.sessionDate}`);
        return { action: 'BLOCKED', detail: `daily close failed: ${response.error ?? 'unknown'}` };
      }
      if (response.status === 'QUEUED') {
        return { action: 'BLOCKED', detail: 'flatten queued; reconciliation confirms the close.' };
      }
      await this.prisma.xauusdSarCycle.updateMany({
        where: { accountId, entryTicket: row.brokerTicket, exitAt: null },
        data: { exitFillPrice: response.fillPrice ?? null, exitAt: new Date(nowMs), exitReason: 'DAILY_CLOSE' },
      });
    }

    await this.prisma.xauusdSarSession.update({
      where: { accountId },
      data: {
        state: 'DAILY_CLOSED',
        cycleId: null,
        direction: null,
        entryFillPrice: null,
        extremeSinceEntry: null,
        reversalLevel: null,
        brokerTicket: null,
        unknownSince: null,
      },
    });
    this.announce(sarDailyClosedMessage({ sessionDate: row.sessionDate }), `sar:daily-closed:${accountId}:${row.sessionDate}`);
    return { action: 'DAILY_CLOSED', detail: 'flat and closed for the day.' };
  }
}

export const XAUUSD_SAR_EXECUTION_VERSION = XAUUSD_SAR_STRATEGY_VERSION;
export { SPEC as SAR_SPEC };
