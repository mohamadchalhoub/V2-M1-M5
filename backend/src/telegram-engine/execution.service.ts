/**
 * Engine B's single path from "the channel published something" to "the
 * broker has it".
 *
 * The step order is dictated by one question: **what happens if this process
 * dies here?**
 *
 *   1. discard anything not from the source channel      — nothing written
 *   2. parse, or refuse                                  — nothing written
 *   3. INSERT the signal row                             — durable identity
 *   4. semantic repost check
 *   5. lifetime check for the signal
 *   6. availability: account, permissions, market, quote
 *   7. plan legs, check margin
 *   8. claim the signal group                            — atomic
 *   9. per leg: re-check the lifetime, mark PENDING, send, record
 *
 * Step 3 is the one that looks like bookkeeping and is not. The row's unique
 * `(accountId, engineVersion, sourceKey)` is written BEFORE any gate runs, so
 * a message that was refused for a closed market is still recognisable as
 * already-seen when Telegram redelivers it after a reconnect. If the insert
 * came after the gates, the closed-market refusal would be forgotten and the
 * redelivery would be treated as new.
 *
 * Step 9 marks each leg PENDING before its broker call for the same reason
 * Engine A does: a crash between the mark and the answer leaves a row saying
 * "this may exist at the broker", which reconciliation can resolve, rather
 * than a row saying "never sent" next to a real position.
 *
 * ## Nothing here consults a schedule
 *
 * There is no import of Engine A's schedule module and no call that could
 * return a time-of-day block. A valid fresh signal at 16:00 Beirut, or at
 * 00:30, is executed.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { BrokerStopConstraints } from '../xauusd-m1m5/brackets';
import type { Mt5PermissionSnapshot } from '../xauusd-m1m5/mt5-readiness';
import { evaluateTelegramAvailability } from './availability';
import { getTelegramExecutionMode, isTelegramSubmissionEnabled } from './controls';
import { evaluateDuplicate, restatementKey, semanticKey, sourceKey } from './duplicate';
import { legMayBeSubmitted, evaluateFreshness } from './freshness';
import type { TelegramSourceMessage } from './ingestion.port';
import { groupMarginRequired, planLegs, type TelegramLeg } from './legs';
import { legIdempotencyTag } from './idempotency';
import { firstTarget } from './tp1';
import type { Direction } from './spec';
import { parseTelegramSignal, TELEGRAM_PARSER_VERSION } from './parser';
import { TelegramEngineNotificationService } from './notifications/notification.service';
import {
  signalReceivedMessage,
  signalSkippedMessage,
  tradeExecutedMessage,
  uncertainExecutionMessage,
} from './notifications/messages';
import { TELEGRAM_SPEC, TELEGRAM_ENGINE_VERSION } from './spec';

export type TelegramOutcome =
  /** At least one leg reached the broker. */
  | 'SUBMITTED'
  /** Not from the source channel, or not a trade instruction. Not recorded. */
  | 'DISCARDED_NOT_SOURCE'
  | 'DISCARDED_NOT_A_SIGNAL'
  /** Same message, or the same trade reposted inside the window. */
  | 'TELEGRAM_DUPLICATE_SIGNAL'
  /** Past its 60-second lifetime. Consumed permanently. */
  | 'TELEGRAM_SIGNAL_EXPIRED'
  /** Broker XAUUSD closed or unknown. Consumed permanently, never replayed. */
  | 'TELEGRAM_MARKET_CLOSED'
  /** Some other availability block: permissions, quote, symbol, recovery. */
  | 'TELEGRAM_UNAVAILABLE'
  /** The market is materially worse than published, or the broker would
   * reject a level. Favourable movement is NOT this — see
   * TELEGRAM_AWAITING_ENTRY_RETRACE. */
  | 'TELEGRAM_LEGS_REFUSED'
  /**
   * Price had already moved favourably off the published entry. Not a
   * refusal: the signal is parked and re-tried by
   * `TelegramEntryRetraceWatchService` until it either retraces to the
   * entry (opened there) or reaches TP1 first (cancelled outright), bounded
   * by the signal's own lifetime.
   */
  | 'TELEGRAM_AWAITING_ENTRY_RETRACE'
  /** Price already reached the first target; the signal is spent. */
  | 'TELEGRAM_TP1_ALREADY_REACHED'
  | 'TELEGRAM_INSUFFICIENT_MARGIN'
  /** Another Telegram signal group is already in flight. */
  | 'TELEGRAM_OCCUPIED'
  /** Every gate passed but the mode forbids reaching the broker. */
  | 'TELEGRAM_NOT_SUBMITTING_MODE';

export interface TelegramResult {
  readonly outcome: TelegramOutcome;
  readonly signalId: string | null;
  readonly detail: string;
  readonly legsSubmitted: number;
}

export interface TelegramSubmitRequest {
  readonly signalId: string;
  readonly legId: string;
  readonly legIndex: number;
  readonly direction: 'BUY' | 'SELL';
  readonly volumeLots: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly magicNumber: number;
}

export interface TelegramSubmitResponse {
  readonly status: 'FILLED' | 'FAILED' | 'UNKNOWN' | 'QUEUED';
  readonly ticket?: string;
  readonly fillPrice?: number;
  readonly brokerStopLoss?: number;
  readonly brokerTakeProfit?: number;
  readonly error?: string;
}

/** The broker hand-off, injected so this is testable without one. */
export interface TelegramBrokerPort {
  submit(request: TelegramSubmitRequest): Promise<TelegramSubmitResponse>;
}

/**
 * Everything the decision is made from, gathered by the caller so that this
 * service queries for nothing and every branch is reachable in a test.
 */
export interface TelegramExecutionContext {
  readonly accountId: string;
  readonly nowMs: number;
  readonly snapshot: Mt5PermissionSnapshot | null;
  readonly expectedLoginId: string | null;
  readonly symbolSessionOpen: boolean | null;
  readonly symbolTradable: boolean | null;
  readonly quote: { bid: number; ask: number; tickAtMs: number } | null;
  readonly constraints: BrokerStopConstraints;
  readonly contractSize: number;
  readonly leverage: number | null;
  readonly freeMargin: number | null;
  /**
   * Whether the Telegram reconciliation worker has actually recovered
   * broker state. Read from `telegram_reconciliation_state` by the caller,
   * never assumed: until a pass has run, a new submission could duplicate
   * an order whose outcome nobody has checked.
   */
  readonly recoveryComplete: boolean;
  /** Overrides the configured adverse-entry bound; used by tests. */
  readonly maxAdverseUsd?: number;
}

@Injectable()
export class TelegramEngineExecutionService {
  private readonly logger = new Logger(TelegramEngineExecutionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject('TELEGRAM_BROKER_PORT') private readonly broker: TelegramBrokerPort,
    // Optional so the execution service stays constructible with `new` in
    // tests and in the scheduler, exactly as Engine A's is. A missing
    // notifier must never stop a trade being recorded or sent: alerting is
    // downstream of the decision, never a gate on it.
    @Optional() private readonly notifier?: TelegramEngineNotificationService,
  ) {}

  /**
   * Fire-and-forget alerting.
   *
   * Never awaited into the decision path and never allowed to throw: the
   * outcome is already durable by the time this is called, and a Telegram
   * outage must not roll back something that has already happened at the
   * broker.
   */
  private announce(eventType: string, dedupKey: string, text: string, audience: 'TRADING' | 'OPS' = 'TRADING'): void {
    void this.notifier?.notify(eventType, dedupKey, text, audience).catch(() => undefined);
  }

  async process(message: TelegramSourceMessage, ctx: TelegramExecutionContext): Promise<TelegramResult> {
    const none = (outcome: TelegramOutcome, detail: string): TelegramResult => ({
      outcome,
      signalId: null,
      detail,
      legsSubmitted: 0,
    });

    // --- 1. Source. A message whose channel cannot be established is
    // discarded rather than assumed to be the source: the whole engine rests
    // on trusting exactly one publisher.
    if ((message.channelUsername ?? '').toLowerCase() !== TELEGRAM_SPEC.sourceChannelUsername.toLowerCase()) {
      return none(
        'DISCARDED_NOT_SOURCE',
        `Message is from ${message.channelUsername ?? 'an unidentified channel'}, not @${TELEGRAM_SPEC.sourceChannelUsername}.`,
      );
    }

    // --- 2. Parse. Most of what this channel publishes is not an order, and
    // a message that is not unambiguously one is not recorded as a signal at
    // all — the signal table is the record of trades this engine was told to
    // take, not a mirror of the channel.
    const parsed = parseTelegramSignal(message.text);
    const parserCompletedAtMs = this.now();
    if (parsed.signal === null) {
      return none('DISCARDED_NOT_A_SIGNAL', `${parsed.refusal}: ${parsed.detail}`);
    }
    const signal = parsed.signal;

    if (message.publishedAtMs === null) {
      return none(
        'TELEGRAM_SIGNAL_EXPIRED',
        'The transport supplied no publication timestamp, so the signal’s age cannot be measured. A signal that ' +
          'cannot be shown to be within its 60-second lifetime is refused, never assumed fresh.',
      );
    }
    const publishedAtMs = message.publishedAtMs;

    const keys = {
      sourceKey: sourceKey(message.channelId, message.messageId),
      semanticKey: semanticKey(signal),
      restatementKey: restatementKey(signal),
      publishedAtMs,
    };

    // --- 3. Durable identity BEFORE any gate. See the header.
    let row;
    try {
      row = await this.prisma.telegramSignal.create({
        data: {
          engineVersion: TELEGRAM_ENGINE_VERSION,
          accountId: ctx.accountId,
          symbol: TELEGRAM_SPEC.symbol,
          channelId: message.channelId,
          messageId: message.messageId,
          sourceKey: keys.sourceKey,
          semanticKey: keys.semanticKey,
          restatementKey: keys.restatementKey,
          publishedAt: new Date(publishedAtMs),
          receivedAt: new Date(message.receivedAtMs),
          rawText: message.text ?? '',
          direction: signal.direction,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfits: signal.takeProfits as number[],
          outcome: 'RECEIVED',
          detail: 'Recorded; gates not yet evaluated.',
          tp1: firstTarget(signal.direction, signal.takeProfits),
          parserVersion: TELEGRAM_PARSER_VERSION,
          // The timeline. publishedAt is the only instant the 60-second
          // rule uses; these others exist to answer WHERE time went when a
          // signal turns out to have been submitted late.
          parserCompletedAt: new Date(parserCompletedAtMs),
          decisionAt: new Date(ctx.nowMs),
          publicationToIngestionMs: Math.max(0, Math.round(message.receivedAtMs - publishedAtMs)),
          ingestionToParseMs: Math.max(0, Math.round(parserCompletedAtMs - message.receivedAtMs)),
          parseToDecisionMs: Math.max(0, Math.round(ctx.nowMs - parserCompletedAtMs)),
          publicationToDecisionMs: Math.max(0, Math.round(ctx.nowMs - publishedAtMs)),
          evidence: {
            parsed: { ...signal, takeProfits: [...signal.takeProfits] },
            publishedAtMs,
            receivedAtMs: message.receivedAtMs,
            executionMode: getTelegramExecutionMode(),
          },
        },
      });
    } catch (err) {
      // The unique key IS the message's identity. A redelivered update, a
      // reconnect replay and a restart replay all land here, and all must
      // produce no second order. This is a normal, expected outcome.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return none(
          'TELEGRAM_DUPLICATE_SIGNAL',
          `Message ${keys.sourceKey} has already been recorded; it produces no second order however it arrived again.`,
        );
      }
      throw err;
    }

    // The signal is durable now, so it is safe to talk about. Sent before the
    // gates run, so the operator sees what arrived even when it is then
    // refused -- and can compare the two.
    this.announce(
      'SIGNAL_RECEIVED',
      `telegram:signal:${row.id}`,
      signalReceivedMessage({
        messageId: message.messageId,
        direction: signal.direction,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfits: [...signal.takeProfits],
        tp1: firstTarget(signal.direction, signal.takeProfits),
        publishedAtIso: new Date(publishedAtMs).toISOString(),
        receivedAtIso: new Date(message.receivedAtMs).toISOString(),
        ingestionLatencyMs: message.receivedAtMs - publishedAtMs,
        signalAgeMs: ctx.nowMs - publishedAtMs,
      }),
    );

    const settle = async (outcome: TelegramOutcome, detail: string, extra: Prisma.TelegramSignalUpdateInput = {}) => {
      await this.prisma.telegramSignal.update({ where: { id: row.id }, data: { outcome, detail, ...extra } });
      // Every refusal is announced, not just the successes. A signal that
      // did NOT trade is exactly what an operator watching the channel will
      // ask about, and silence is the answer that sends them to the logs.
      this.announce(
        outcome,
        `telegram:skip:${row.id}:${outcome}`,
        signalSkippedMessage(outcome, detail, {
          messageId: message.messageId,
          direction: signal.direction,
          entry: signal.entry,
        }),
      );
      return { outcome, signalId: row.id, detail, legsSubmitted: 0 };
    };

    // --- 4. Semantic repost: a genuinely new message carrying a trade
    // already taken. Identity cannot catch it, so content does.
    // Selected on EITHER key: a restatement shares the restatement key but
    // not the semantic one, so filtering on semanticKey alone would never
    // load the row that proves it is a repost.
    const priors = await this.prisma.telegramSignal.findMany({
      where: {
        accountId: ctx.accountId,
        id: { not: row.id },
        publishedAt: { gte: new Date(publishedAtMs - TELEGRAM_SPEC.semanticDuplicateWindowMs) },
        OR: [{ semanticKey: keys.semanticKey }, { restatementKey: keys.restatementKey }],
      },
      select: { sourceKey: true, semanticKey: true, restatementKey: true, publishedAt: true },
    });
    const dup = evaluateDuplicate(
      keys,
      priors.map((p) => ({
        sourceKey: p.sourceKey,
        semanticKey: p.semanticKey,
        restatementKey: p.restatementKey,
        publishedAtMs: p.publishedAt.getTime(),
      })),
    );
    if (dup.duplicate) return settle('TELEGRAM_DUPLICATE_SIGNAL', dup.detail!);

    // --- 5. The 60-second lifetime, at signal level. Re-checked per leg
    // later; this is the early exit that avoids doing work on a dead signal.
    const freshness = evaluateFreshness(publishedAtMs, ctx.nowMs);
    if (!freshness.fresh) return settle('TELEGRAM_SIGNAL_EXPIRED', freshness.detail);

    // --- 6. Availability. Account safety and market reality only; no
    // schedule of any kind. A closed market is terminal here, not a queue.
    const availability = evaluateTelegramAvailability({
      nowMs: ctx.nowMs,
      snapshot: ctx.snapshot,
      expectedLoginId: ctx.expectedLoginId,
      symbolSessionOpen: ctx.symbolSessionOpen,
      symbolTradable: ctx.symbolTradable,
      quote: ctx.quote,
      recoveryComplete: ctx.recoveryComplete,
    });
    if (!availability.available) {
      return settle(
        availability.marketClosed ? 'TELEGRAM_MARKET_CLOSED' : 'TELEGRAM_UNAVAILABLE',
        `${availability.block}: ${availability.detail}`,
      );
    }
    const quote = ctx.quote!;

    // --- 7. Legs and margin, for the group as a whole.
    // The TP1 latch is read from the row rather than recomputed, so a
    // touch recorded by the price watcher cancels this evaluation even
    // though the current quote has since retraced past the level.
    const tp1 = firstTarget(signal.direction, signal.takeProfits);
    const plan = planLegs({
      signal,
      quote,
      constraints: ctx.constraints,
      tp1AlreadyTouched: row.tp1Touched,
      maxAdverseUsd: ctx.maxAdverseUsd,
    });
    if (plan.legs === null) {
      // A spent signal is its own outcome, not a generic refusal: it is
      // the one case where nothing was wrong with the signal at all.
      const spent = plan.refusal === 'TELEGRAM_TP1_ALREADY_REACHED';
      // Favourable movement is not a refusal any more either: it is parked
      // and re-tried by TelegramEntryRetraceWatchService (see there for the
      // two ways out) rather than settled here.
      const awaitingEntry = !spent && plan.refusal === 'TELEGRAM_ADVERSE_ENTRY_DEVIATION' && plan.favourable === true;
      if (awaitingEntry) {
        return settle(
          'TELEGRAM_AWAITING_ENTRY_RETRACE',
          `${plan.detail} Not refused: the signal is watched, and will be taken if price retraces to the ` +
            'published entry, or cancelled outright if it reaches the first target first.',
          {
            executablePrice: plan.executablePrice,
            deviationUsd: plan.deviationUsd,
            favourableEntry: plan.favourable,
            tp1: plan.tp1,
          },
        );
      }
      return settle(
        spent ? 'TELEGRAM_TP1_ALREADY_REACHED' : 'TELEGRAM_LEGS_REFUSED',
        `${plan.refusal}: ${plan.detail}`,
        {
          executablePrice: plan.executablePrice,
          deviationUsd: plan.deviationUsd,
          favourableEntry: plan.favourable,
          tp1: plan.tp1,
          // Latch it on the row too, so a later evaluation of the same
          // signal cannot come to a different conclusion.
          ...(spent && !row.tp1Touched
            ? { tp1Touched: true, tp1TouchedAt: new Date(ctx.nowMs), tp1TouchPrice: plan.executablePrice }
            : {}),
        },
      );
    }
    const legs = plan.legs;
    const marginRequired = groupMarginRequired(legs, ctx.contractSize, plan.executablePrice!, ctx.leverage);
    if (ctx.freeMargin === null || !(marginRequired <= ctx.freeMargin)) {
      return settle(
        'TELEGRAM_INSUFFICIENT_MARGIN',
        ctx.freeMargin === null
          ? 'Free margin is unknown, which refuses rather than permits: an unread account is not a solvent one.'
          : `The group requires ${fmt(marginRequired)} of margin against ${fmt(ctx.freeMargin)} free. Checked for ` +
            'the whole group, because the legs are submitted within moments of each other.',
        { executablePrice: plan.executablePrice, deviationUsd: plan.deviationUsd, favourableEntry: plan.favourable, tp1: plan.tp1 },
      );
    }

    const result = await this.claimAndSubmitLegs(
      row.id,
      { direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss },
      legs,
      plan,
      ctx,
      message.messageId,
      publishedAtMs,
      { settleOccupiedAsTerminal: true },
    );
    // Never null: settleOccupiedAsTerminal:true means every branch inside
    // returns a result rather than bailing out silently.
    return result!;
  }

  /**
   * Everything from "claim the group" through "record the outcome and
   * notify", shared between a fresh signal (`process`) and one resuming
   * after waiting for its entry to retrace (`retryAwaitingEntry`).
   *
   * `settleOccupiedAsTerminal` is the one place the two callers differ: a
   * fresh signal that loses the occupancy race is consumed (`TELEGRAM_
   * OCCUPIED`, terminal — queueing it would execute it after its lifetime).
   * A signal that has been waiting for its entry does not get a second
   * chance revoked by a race that may resolve within the next second, so it
   * is left AWAITING and retried on the next sweep instead — this method
   * returns `null` rather than settling anything.
   */
  private async claimAndSubmitLegs(
    signalId: string,
    signal: { direction: 'BUY' | 'SELL'; entry: number; stopLoss: number },
    legs: readonly TelegramLeg[],
    plan: { executablePrice: number | null; deviationUsd: number | null; favourable: boolean; tp1: number | null },
    ctx: TelegramExecutionContext,
    messageId: string,
    publishedAtMs: number,
    options: { settleOccupiedAsTerminal: boolean },
  ): Promise<TelegramResult | null> {
    const settle = async (outcome: TelegramOutcome, detail: string, extra: Prisma.TelegramSignalUpdateInput = {}) => {
      await this.prisma.telegramSignal.update({ where: { id: signalId }, data: { outcome, detail, ...extra } });
      this.announce(
        outcome,
        `telegram:skip:${signalId}:${outcome}`,
        signalSkippedMessage(outcome, detail, { messageId, direction: signal.direction, entry: signal.entry }),
      );
      return { outcome, signalId, detail, legsSubmitted: 0 };
    };

    // --- 8. Claim the group. Atomic; losing the race consumes a FRESH
    // signal rather than queueing it. A signal resuming from AWAITING_ENTRY
    // just tries again next sweep.
    try {
      await this.prisma.telegramSignalGroupLock.create({
        data: { accountId: ctx.accountId, signalId, state: 'RESERVED' },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (!options.settleOccupiedAsTerminal) return null;
        return settle(
          'TELEGRAM_OCCUPIED',
          'Another Telegram signal group is already in flight for this account. The signal is recorded and ' +
            'consumed; it is not queued behind the one in flight, which would execute it after its lifetime.',
          { executablePrice: plan.executablePrice, deviationUsd: plan.deviationUsd, favourableEntry: plan.favourable, tp1: plan.tp1 },
        );
      }
      throw err;
    }

    const legRows = await this.createLegRows(signalId, legs);

    // SHADOW runs every gate above and stops here, so a shadow run rehearses
    // exactly what a live one would do.
    if (!isTelegramSubmissionEnabled()) {
      await this.releaseGroup(ctx.accountId);
      await this.prisma.telegramSignalLeg.updateMany({
        where: { signalId },
        data: { orderStatus: 'SKIPPED', skipReason: `NOT_SUBMITTING_MODE_${getTelegramExecutionMode()}` },
      });
      return settle(
        'TELEGRAM_NOT_SUBMITTING_MODE',
        `Execution mode is ${getTelegramExecutionMode()}; every gate passed and ${legs.length} leg(s) were planned, ` +
          'but nothing was queued.',
        { executablePrice: plan.executablePrice, deviationUsd: plan.deviationUsd, favourableEntry: plan.favourable, tp1: plan.tp1 },
      );
    }

    await this.prisma.telegramSignalGroupLock.update({
      where: { accountId: ctx.accountId },
      data: { state: 'SENT' },
    });

    // --- 9. Submit each leg, re-checking the lifetime immediately before
    // each one.
    let submitted = 0;
    let expiredMidGroup = 0;
    for (const [i, leg] of legs.entries()) {
      const legRow = legRows[i];
      const atMs = this.now();
      const legFresh = legMayBeSubmitted(publishedAtMs, atMs);
      if (!legFresh.fresh) {
        expiredMidGroup += 1;
        await this.prisma.telegramSignalLeg.update({
          where: { id: legRow.id },
          data: {
            orderStatus: 'SKIPPED',
            skipReason: 'TELEGRAM_SIGNAL_EXPIRED',
            ageAtSubmissionMs: Math.round(legFresh.ageMs),
            publicationToSubmissionMs: Math.round(legFresh.ageMs),
          },
        });
        continue;
      }

      // Durable BEFORE the broker call.
      await this.prisma.telegramSignalLeg.update({
        where: { id: legRow.id },
        data: {
          orderStatus: 'PENDING',
          sentAt: new Date(atMs),
          submittedAt: new Date(atMs),
          ageAtSubmissionMs: Math.round(legFresh.ageMs),
          // The number the lifetime rule is actually about.
          publicationToSubmissionMs: Math.round(legFresh.ageMs),
          decisionToSubmissionMs: Math.max(0, Math.round(atMs - ctx.nowMs)),
        },
      });

      let response: TelegramSubmitResponse;
      try {
        response = await this.broker.submit({
          signalId,
          legId: legRow.id,
          legIndex: leg.legIndex,
          direction: leg.direction,
          volumeLots: leg.volumeLots,
          stopLoss: leg.stopLoss,
          takeProfit: leg.takeProfit,
          magicNumber: leg.magicNumber,
        });
      } catch (err) {
        // "We do not know" is a real outcome and is never flattened into
        // FAILED: the order may already be a live position.
        response = { status: 'UNKNOWN', error: (err as Error).message };
      }
      submitted += 1;

      // A queueing port has handed the leg to the collector but cannot know
      // the broker's answer. The row deliberately stays PENDING: that is what
      // the collector's poll selects on.
      if (response.status === 'QUEUED') continue;

      if (response.status === 'UNKNOWN') {
        // Loud, and its own alert: this leg may be a live position nobody has
        // confirmed, which is the one state an operator must not learn about
        // from a summary line later.
        this.announce(
          'EXECUTION_UNKNOWN',
          `telegram:unknown:${legRow.id}`,
          uncertainExecutionMessage({
            messageId,
            legIndex: leg.legIndex,
            detail: response.error ?? 'The broker response was lost or ambiguous.',
          }),
          'OPS',
        );
      }

      const ackMs = this.now();
      await this.prisma.telegramSignalLeg.update({
        where: { id: legRow.id },
        data: {
          orderStatus: response.status,
          ticket: response.ticket ? BigInt(response.ticket) : null,
          fillPrice: response.fillPrice ?? null,
          brokerStopLoss: response.brokerStopLoss ?? null,
          brokerTakeProfit: response.brokerTakeProfit ?? null,
          acknowledgedAt: new Date(ackMs),
          submissionToBrokerAckMs: Math.max(0, Math.round(ackMs - atMs)),
          filledAt: response.status === 'FILLED' ? new Date(ackMs) : null,
          failureReason: response.error ?? null,
        },
      });
    }

    const anyUnresolved = await this.prisma.telegramSignalLeg.count({
      where: { signalId, orderStatus: { in: ['PENDING', 'UNKNOWN', 'FILLED'] } },
    });
    if (anyUnresolved === 0) {
      // Every leg is broker-confirmed refused or skipped, so nothing can
      // exist at the broker and releasing the group is safe.
      await this.releaseGroup(ctx.accountId);
    } else {
      await this.prisma.telegramSignalGroupLock.update({
        where: { accountId: ctx.accountId },
        data: { state: 'FILLED' },
      });
    }

    const detail =
      `${legs.length} leg(s) planned, ${submitted} submitted` +
      (expiredMidGroup > 0 ? ', 1 skipped for passing its lifetime mid-submission' : '') +
      '.';
    await this.prisma.telegramSignal.update({
      where: { id: signalId },
      data: {
        outcome: submitted > 0 ? 'SUBMITTED' : 'TELEGRAM_SIGNAL_EXPIRED',
        detail,
        executablePrice: plan.executablePrice,
        deviationUsd: plan.deviationUsd,
        favourableEntry: plan.favourable,
        tp1: plan.tp1,
      },
    });
    if (submitted > 0) {
      const finalLegs = await this.prisma.telegramSignalLeg.findMany({
        where: { signalId },
        orderBy: { legIndex: 'asc' },
      });
      this.announce(
        'TRADE_SUBMITTED',
        `telegram:executed:${signalId}`,
        tradeExecutedMessage({
          messageId,
          direction: signal.direction,
          sourceEntry: signal.entry,
          stopLoss: signal.stopLoss,
          legs: finalLegs.map((l) => ({
            legIndex: l.legIndex,
            legCount: finalLegs.length,
            volumeLots: Number(l.volumeLots),
            takeProfit: Number(l.takeProfit),
            fillPrice: l.fillPrice === null ? null : Number(l.fillPrice),
            ticket: l.ticket === null ? null : String(l.ticket),
            status: l.orderStatus,
          })),
          signalAgeAtExecutionMs: this.now() - publishedAtMs,
          mode: getTelegramExecutionMode(),
        }),
      );
    }

    return {
      outcome: submitted > 0 ? 'SUBMITTED' : 'TELEGRAM_SIGNAL_EXPIRED',
      signalId,
      detail,
      legsSubmitted: submitted,
    };
  }

  /**
   * Re-evaluates a signal parked as `TELEGRAM_AWAITING_ENTRY_RETRACE`
   * against the current market. Called by `TelegramEntryRetraceWatchService`
   * on a sweep, never from the message-processing path.
   *
   * Returns `null` when nothing changed — the signal is still waiting and
   * nothing was written — so the caller can distinguish "still watching"
   * from "resolved" without a sentinel outcome.
   */
  async retryAwaitingEntry(signalId: string, ctx: TelegramExecutionContext): Promise<TelegramResult | null> {
    const row = await this.prisma.telegramSignal.findUnique({ where: { id: signalId } });
    if (!row || row.outcome !== 'TELEGRAM_AWAITING_ENTRY_RETRACE') return null;
    if (row.direction === null || row.entry === null || row.stopLoss === null) return null;

    const publishedAtMs = row.publishedAt.getTime();
    const signal = {
      direction: row.direction as Direction,
      entry: Number(row.entry),
      stopLoss: Number(row.stopLoss),
      takeProfits: row.takeProfits.map((tp) => Number(tp)),
    };

    const settle = async (outcome: TelegramOutcome, detail: string, extra: Prisma.TelegramSignalUpdateInput = {}) => {
      await this.prisma.telegramSignal.update({ where: { id: row.id }, data: { outcome, detail, ...extra } });
      this.announce(
        outcome,
        `telegram:skip:${row.id}:${outcome}`,
        signalSkippedMessage(outcome, detail, { messageId: row.messageId, direction: signal.direction, entry: signal.entry }),
      );
      return { outcome, signalId: row.id, detail, legsSubmitted: 0 };
    };

    // The TP1 watcher latches independently of this sweep and may have
    // reached it first; either way, the outcome is the same.
    if (row.tp1Touched) {
      return settle(
        'TELEGRAM_TP1_ALREADY_REACHED',
        'The first target was reached while this signal was waiting for its entry to retrace. It is cancelled ' +
          'outright: the move it described has already happened without it, and it is never taken at a worse ' +
          'level than published.',
      );
    }

    const freshness = evaluateFreshness(publishedAtMs, ctx.nowMs);
    if (!freshness.fresh) {
      return settle(
        'TELEGRAM_SIGNAL_EXPIRED',
        `${freshness.detail} It was awaiting its published entry to retrace and never got there.`,
      );
    }

    const availability = evaluateTelegramAvailability({
      nowMs: ctx.nowMs,
      snapshot: ctx.snapshot,
      expectedLoginId: ctx.expectedLoginId,
      symbolSessionOpen: ctx.symbolSessionOpen,
      symbolTradable: ctx.symbolTradable,
      quote: ctx.quote,
      recoveryComplete: ctx.recoveryComplete,
    });
    if (!availability.available) {
      // Transient (a quote gap, an account snapshot not yet read this
      // instant). Neither of this wait's two exits, so it is retried next
      // sweep rather than settled.
      return null;
    }
    const quote = ctx.quote!;

    const plan = planLegs({
      signal,
      quote,
      constraints: ctx.constraints,
      tp1AlreadyTouched: false,
      maxAdverseUsd: ctx.maxAdverseUsd,
    });

    if (plan.legs === null) {
      if (plan.refusal === 'TELEGRAM_TP1_ALREADY_REACHED') {
        return settle('TELEGRAM_TP1_ALREADY_REACHED', plan.detail ?? 'The first target has been reached.', {
          executablePrice: plan.executablePrice,
          tp1Touched: true,
          tp1TouchedAt: new Date(ctx.nowMs),
          tp1TouchPrice: plan.executablePrice,
        });
      }
      // Still favourable (has not retraced yet), or adverse beyond the
      // configured bound, or a broker-stop refusal at the current market:
      // none of these end the wait. Only a retrace into the eligible zone
      // or TP1 being reached does.
      return null;
    }

    const marginRequired = groupMarginRequired(plan.legs, ctx.contractSize, plan.executablePrice!, ctx.leverage);
    if (ctx.freeMargin === null || !(marginRequired <= ctx.freeMargin)) {
      return settle(
        'TELEGRAM_INSUFFICIENT_MARGIN',
        ctx.freeMargin === null
          ? 'Free margin is unknown, which refuses rather than permits: an unread account is not a solvent one.'
          : `The group requires ${fmt(marginRequired)} of margin against ${fmt(ctx.freeMargin)} free.`,
        { executablePrice: plan.executablePrice, deviationUsd: plan.deviationUsd, favourableEntry: plan.favourable, tp1: plan.tp1 },
      );
    }

    return this.claimAndSubmitLegs(
      row.id,
      { direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss },
      plan.legs,
      plan,
      ctx,
      row.messageId,
      publishedAtMs,
      { settleOccupiedAsTerminal: false },
    );
  }

  /**
   * Overridable clock. The leg loop must read the time AGAIN before each
   * submission rather than reusing the context's instant — reusing it would
   * make the per-leg lifetime check a copy of the signal-level one and prove
   * nothing.
   */
  protected now(): number {
    return Date.now();
  }

  private async createLegRows(signalId: string, legs: readonly TelegramLeg[]) {
    const created = [];
    for (const leg of legs) {
      created.push(
        await this.prisma.telegramSignalLeg.create({
          data: {
            signalId,
            // Derived, not random: the same leg recomputes to the same tag
            // after a restart, which is what lets recovery match a position
            // this process opened before it died.
            idempotencyTag: legIdempotencyTag(signalId, leg.legIndex),
            legIndex: leg.legIndex,
            direction: leg.direction,
            volumeLots: leg.volumeLots,
            sourceEntry: leg.sourceEntry,
            stopLoss: leg.stopLoss,
            takeProfit: leg.takeProfit,
            magicNumber: leg.magicNumber,
          },
        }),
      );
    }
    return created;
  }

  private async releaseGroup(accountId: string): Promise<void> {
    await this.prisma.telegramSignalGroupLock.deleteMany({ where: { accountId } });
  }
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'an unknown amount';
}
