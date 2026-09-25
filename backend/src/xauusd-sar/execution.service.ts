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
import { readFlattenRequired } from './flatten-required';
import { SAR_MAGIC, SAR_WATCHDOG_STALE_THRESHOLD_MS } from './safety-constants';
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
  enterRecoveryRequired,
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
  /**
   * FLATTEN is distinct from REVERSAL: both carry `closingTicket`, but only
   * REVERSAL opens a new position afterward. FLATTEN (daily close only)
   * closes and stops there -- see closeForDay()'s own comment for the
   * production bug this distinction fixes (daily close used to reuse
   * 'REVERSAL', which the collector always followed with a fresh open in
   * the opposite direction, defeating "no new exposure at close").
   */
  readonly kind: 'INITIAL' | 'REVERSAL' | 'FLATTEN';
  readonly direction: SarDirection;
  readonly volumeLots: number;
  readonly magicNumber: number;
  readonly idempotencyTag: string;
  /** Present for a REVERSAL or FLATTEN: the ticket of the position being closed. */
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
    // An operator flatten-required marker takes precedence over the
    // strategy: no entry and no reversal until the named position is closed.
    if (readFlattenRequired() !== null) {
      return { action: 'BLOCKED', detail: 'flatten required: the strategy is paused until the stranded position is closed.' };
    }
    if (isWithinDailyClose(nowMs)) return { action: 'NONE', detail: 'within the daily close window.' };

    const blocked = sarEntriesBlockedByControls();
    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId } });
    if (!row) return { action: 'NONE', detail: 'no session row.' };
    if (row.state === 'REVERSAL_UNKNOWN') return { action: 'BLOCKED', detail: 'blocked on an UNKNOWN submission; reconciliation must resolve it.' };
    if (row.state === 'RECOVERY_REQUIRED') {
      return { action: 'BLOCKED', detail: 'broker/session ownership mismatch — operator recovery required before any evaluation resumes.' };
    }
    if (row.state === 'DAILY_CLOSE_PENDING_CONFIRMATION') {
      return { action: 'BLOCKED', detail: 'daily close filled; awaiting broker-confirmed zero SAR positions.' };
    }
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
        data: { extremeSinceEntry: update.extremeSinceEntry, reversalLevel: update.reversalLevel, lastEvaluatedAt: new Date(nowMs) },
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

  /**
   * Defense-in-depth, not a second engine: this calls the exact same
   * `evaluateTick` that the normal scheduler loop calls, and does so ONLY
   * when that normal path has gone quiet for longer than a healthy cadence
   * ever should (`SAR_WATCHDOG_STALE_THRESHOLD_MS`). It computes nothing of
   * its own about direction, price or ownership -- there is no separate
   * trailing/reversal logic here to drift from the real one.
   *
   * The "at most one broker reversal attempt" invariant falls out of
   * `submitAndResolve`'s existing atomic claim (`updateMany` guarded on the
   * session's CURRENT state) for free: whichever caller -- the normal
   * scheduler tick or this watchdog -- reaches that claim first moves the
   * session out of ACTIVE_BUY/ACTIVE_SELL, and the other's claim then
   * affects zero rows and returns 'lost the claim race for this tick.' This
   * method adds no new claim mechanism, and therefore cannot race around
   * the existing one.
   */
  async watchdogCheck(accountId: string, quote: SarQuoteInput, nowMs: number): Promise<SarTickResult & { readonly watchdogActed: boolean }> {
    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId } });
    if (!row) return { action: 'NONE', detail: 'no session row.', watchdogActed: false };
    if (row.state !== 'ACTIVE_BUY' && row.state !== 'ACTIVE_SELL') {
      // Nothing to watch: WAIT_* has no position yet, DAILY_CLOSED is flat
      // by design, and REVERSAL_UNKNOWN already belongs to reconciliation --
      // the watchdog must never compete with that separate, already-atomic
      // recovery path.
      return { action: 'NONE', detail: `nothing to watch in state ${row.state}.`, watchdogActed: false };
    }

    const lastEvaluatedMs = row.lastEvaluatedAt?.getTime() ?? null;
    const staleForMs = lastEvaluatedMs === null ? Infinity : nowMs - lastEvaluatedMs;
    if (staleForMs < SAR_WATCHDOG_STALE_THRESHOLD_MS) {
      // The normal path is healthy -- it may simply have nothing to do
      // because price hasn't moved. Standing down here, not merely
      // returning NONE from a check, is the hard requirement: the watchdog
      // must not evaluate at all while the normal path is fresh.
      return { action: 'NONE', detail: `normal evaluator is fresh (${(staleForMs / 1000).toFixed(1)}s); watchdog stands down.`, watchdogActed: false };
    }

    if (!quote.fresh) {
      // A stale quote is not evidence of anything the watchdog can act on
      // safely -- it would be reasoning from the same stale information the
      // normal path already had, not independent confirmation.
      return { action: 'NONE', detail: `quote is stale (${quote.ageSeconds.toFixed(1)}s); watchdog will not guess.`, watchdogActed: false };
    }

    this.logger.warn(
      `xauusd-sar watchdog: normal evaluator stale for ${(staleForMs / 1000).toFixed(1)}s (threshold ${SAR_WATCHDOG_STALE_THRESHOLD_MS / 1000}s); evaluating directly.`,
    );
    const result = await this.evaluateTick(accountId, quote, nowMs);
    return { ...result, watchdogActed: true };
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
      kind: 'INITIAL' | 'REVERSAL' | 'FLATTEN';
      closingTicket: string | null;
      cycleId: string;
      idempotencyTag: string;
      volume: number;
      nowMs: number;
    },
    response: SarSubmitResponse,
  ): Promise<SarTickResult> {
    const { accountId, session, direction, kind, closingTicket, cycleId, idempotencyTag, volume, nowMs } = ctx;

    // FLATTEN never opens a new position on FILLED -- see closeForDay()'s
    // own comment for the production bug this distinction fixes.
    if (kind === 'FLATTEN') {
      if (response.status === 'FILLED') {
        // 2026-09-25 hardening pass: a successful close-order acknowledgment
        // ALONE is NOT sufficient to declare DAILY_CLOSED. Record the fill
        // (we DO know the close order was accepted -- that part is real),
        // but move to DAILY_CLOSE_PENDING_CONFIRMATION and KEEP brokerTicket
        // set (deliberately not cleared yet) so reconciliation's
        // confirmDailyCloseFlat() can compare a fresh broker snapshot
        // against exactly this ticket before ever clearing ownership or
        // setting DAILY_CLOSED. See reconciliation.service.ts.
        await this.prisma.xauusdSarOrderAttempt.update({
          where: { idempotencyTag },
          data: { status: 'FILLED', ticket: response.ticket ?? null, fillPrice: response.fillPrice ?? null, resolvedAt: new Date() },
        });
        if (closingTicket) {
          await this.prisma.xauusdSarCycle.updateMany({
            where: { accountId, entryTicket: closingTicket, exitAt: null },
            data: { exitTicket: closingTicket, exitFillPrice: response.fillPrice ?? null, exitAt: new Date(nowMs), exitReason: 'DAILY_CLOSE' },
          });
        }
        await this.prisma.xauusdSarSession.update({
          where: { accountId },
          data: { state: 'DAILY_CLOSE_PENDING_CONFIRMATION', unknownSince: null },
        });
        return { action: 'BLOCKED', detail: 'flatten filled; awaiting broker-confirmed zero SAR positions before closing the day.' };
      }
      if (response.status === 'FAILED') {
        await this.prisma.xauusdSarOrderAttempt.update({
          where: { idempotencyTag },
          data: { status: 'FAILED', failureReason: response.error ?? null, resolvedAt: new Date() },
        });
        // Broker-confirmed refusal to flatten: resume managing the
        // existing position exactly as before -- never guess flat.
        await this.prisma.xauusdSarSession.update({
          where: { accountId },
          data: { state: session.direction === 'BUY' ? 'ACTIVE_BUY' : 'ACTIVE_SELL', unknownSince: null },
        });
        return { action: 'NONE', detail: `daily close flatten refused by broker: ${response.error ?? 'no reason given'}` };
      }
      // UNKNOWN: leave state as REVERSAL_UNKNOWN. Reconciliation must resolve it.
      this.announce(sarUnknownMessage({ kind: 'REVERSAL', direction, cycleId, error: response.error ?? 'lost or ambiguous broker answer during daily close' }), `sar:unknown:${accountId}:${cycleId}`);
      return { action: 'BLOCKED', detail: `daily close flatten broker answer UNKNOWN: ${response.error ?? 'no detail'}` };
    }

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
    // The "closing ticket" for a REVERSAL or FLATTEN is whatever ticket the
    // session still shows — the position this attempt is reversing/flattening.
    const closingTicket = attempt.kind === 'REVERSAL' || attempt.kind === 'FLATTEN' ? row.brokerTicket : null;

    return this.applyBrokerResult(
      {
        accountId: attempt.accountId,
        session,
        direction: attempt.direction,
        kind: attempt.kind as 'INITIAL' | 'REVERSAL' | 'FLATTEN',
        closingTicket,
        cycleId: attempt.cycleId,
        idempotencyTag,
        volume: Number(attempt.volume),
        nowMs,
      },
      response,
    );
  }

  /**
   * 23:40 Beirut: stop new exposure, flatten whatever is open, mark
   * DAILY_CLOSED ONLY once broker-confirmed flat.
   *
   * GLOBAL INVARIANT (2026-09-25 incident repair): this method must NEVER
   * transition to DAILY_CLOSED and must NEVER clear cycleId/direction/
   * brokerTicket/entryFillPrice/extremeSinceEntry/reversalLevel/
   * unknownSince unless the session row itself already shows a genuinely
   * flat, fully-resolved state (WAIT_MARKET_OPEN or WAIT_INITIAL_DIRECTION
   * with no brokerTicket) -- regardless of what state it's in. The
   * previous implementation had an implicit `if (ACTIVE_*) {...}` guard
   * with NO else branch, so ANY other state (most critically
   * REVERSAL_UNKNOWN, a routine transient state while a reversal's broker
   * result is still being resolved) fell through to an unconditional wipe
   * with zero broker verification -- confirmed live, 2026-09-24, as
   * exactly what orphaned a real open position from session tracking.
   *
   * This does not query the broker directly (this service has no broker
   * access of its own) -- it trusts the SAME durable, continuously
   * reconciled session row every other path already trusts.
   * `SarReconciliationService` runs on every collector cycle regardless of
   * daily-close timing and is what actually resolves REVERSAL_UNKNOWN /
   * detects RECOVERY_REQUIRED; this method's job is only to never race
   * ahead of that resolution by assuming flat before it's confirmed.
   */
  async closeForDay(accountId: string, nowMs: number): Promise<SarTickResult> {
    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId } });
    if (!row) return { action: 'NONE', detail: 'no session row.' };
    if (row.state === 'DAILY_CLOSED') return { action: 'NONE', detail: 'already closed.' };

    if (row.state === 'REVERSAL_UNKNOWN') {
      return { action: 'BLOCKED', detail: 'an UNKNOWN submission is still unresolved; reconciliation must confirm broker state before daily close can proceed.' };
    }
    if (row.state === 'RECOVERY_REQUIRED') {
      return { action: 'BLOCKED', detail: 'broker/session ownership mismatch — operator recovery required; daily close will not guess flat.' };
    }
    if (row.state === 'DAILY_CLOSE_PENDING_CONFIRMATION') {
      // Already flattened and awaiting reconciliation's independent
      // broker-confirmed-zero-positions check (2026-09-25 hardening pass)
      // -- never resubmit another flatten while one is already pending
      // confirmation.
      return { action: 'BLOCKED', detail: 'flatten already filled; awaiting broker-confirmed zero SAR positions before closing the day.' };
    }

    if (row.state === 'ACTIVE_BUY' || row.state === 'ACTIVE_SELL') {
      if (!row.brokerTicket) return { action: 'BLOCKED', detail: 'active state with no ticket — data defect, refusing to guess.' };
      const volume = await currentSarVolume(this.prisma, accountId);
      if (volume === null) return { action: 'BLOCKED', detail: 'no volume configured for xauusd-sar.' };
      const claim = await this.prisma.xauusdSarSession.updateMany({ where: { accountId, state: row.state }, data: { state: 'REVERSAL_UNKNOWN', unknownSince: new Date(nowMs) } });
      if (claim.count === 0) return { action: 'NONE', detail: 'lost the claim race.' };
      // The queueing broker port persists nothing: the attempt row IS the
      // collector's queue (see queue-broker.port.ts). Without it a FLATTEN
      // was announced as QUEUED but never reached the collector, leaving the
      // session REVERSAL_UNKNOWN with no attempt and the position unmanaged.
      const flattenCycleId = row.cycleId ?? randomUUID();
      const flattenTag = `SARCLOSE${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const flattenDirection: SarDirection = row.direction === 'BUY' ? 'SELL' : 'BUY';
      try {
        await this.prisma.xauusdSarOrderAttempt.create({
          data: { accountId, cycleId: flattenCycleId, idempotencyTag: flattenTag, kind: 'FLATTEN', direction: flattenDirection, volume, status: 'PENDING' },
        });
      } catch (err) {
        await this.prisma.xauusdSarSession.updateMany({ where: { accountId, state: 'REVERSAL_UNKNOWN' }, data: { state: row.state, unknownSince: null } });
        return { action: 'BLOCKED', detail: `could not record the flatten attempt; claim released: ${(err as Error).message}` };
      }
      const response = await this.broker.submit({
        accountId,
        cycleId: flattenCycleId,
        // FLATTEN, never REVERSAL: the collector opens a fresh opposite
        // position after every REVERSAL close by design (that's the whole
        // point of a reversal) -- reusing that kind for a daily close was
        // itself a production bug (it would reopen exposure immediately
        // after "closing" for the day). FLATTEN closes and stops there.
        kind: 'FLATTEN',
        direction: flattenDirection,
        volumeLots: volume,
        magicNumber: SAR_MAGIC,
        idempotencyTag: flattenTag,
        closingTicket: row.brokerTicket,
      });
      if (response.status !== 'FILLED' && response.status !== 'QUEUED') {
        this.announce(sarUnknownMessage({ kind: 'REVERSAL', direction: row.direction!, cycleId: row.cycleId ?? '', error: `daily close failed: ${response.error ?? 'unknown'}` }), `sar:close-fail:${accountId}:${row.sessionDate}`);
        return { action: 'BLOCKED', detail: `daily close failed: ${response.error ?? 'unknown'}` };
      }
      if (response.status === 'QUEUED') {
        await this.prisma.xauusdSarOrderAttempt.update({ where: { idempotencyTag: flattenTag }, data: { status: 'SENT' } });
        // Session stays REVERSAL_UNKNOWN (already claimed above) --
        // reconciliation resolves it on a later cycle, exactly like any
        // other reversal. A LATER call to closeForDay (the scheduler
        // retries every cycle until DAILY_CLOSED) will see the resolved,
        // genuinely-flat state and complete the transition below.
        return { action: 'BLOCKED', detail: 'flatten queued; reconciliation confirms the close before daily close can complete.' };
      }
      // Synchronous FILLED (test broker only -- production is always
      // QUEUED): the close order was acknowledged, but per the same
      // 2026-09-25 hardening as applyBrokerResult's FLATTEN branch, that
      // acknowledgment ALONE is not sufficient -- move to
      // DAILY_CLOSE_PENDING_CONFIRMATION and let reconciliation's
      // confirmDailyCloseFlat() independently verify zero SAR positions
      // before ever setting DAILY_CLOSED or clearing brokerTicket.
      await this.prisma.xauusdSarOrderAttempt.update({
        where: { idempotencyTag: flattenTag },
        data: { status: 'FILLED', ticket: response.ticket ?? null, fillPrice: response.fillPrice ?? null, resolvedAt: new Date(nowMs) },
      });
      await this.prisma.xauusdSarCycle.updateMany({
        where: { accountId, entryTicket: row.brokerTicket, exitAt: null },
        data: { exitFillPrice: response.fillPrice ?? null, exitAt: new Date(nowMs), exitReason: 'DAILY_CLOSE' },
      });
      await this.prisma.xauusdSarSession.update({
        where: { accountId },
        data: { state: 'DAILY_CLOSE_PENDING_CONFIRMATION', unknownSince: null },
      });
      return { action: 'BLOCKED', detail: 'flatten filled; awaiting broker-confirmed zero SAR positions before closing the day.' };
    }

    // Only remaining states here: WAIT_MARKET_OPEN / WAIT_INITIAL_DIRECTION,
    // both of which mean no owned position by construction -- brokerTicket
    // is asserted null as a defensive check, not assumed.
    if (row.brokerTicket !== null) {
      return { action: 'BLOCKED', detail: `state ${row.state} unexpectedly carries brokerTicket=${row.brokerTicket} — data defect, refusing to guess; operator review required.` };
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
