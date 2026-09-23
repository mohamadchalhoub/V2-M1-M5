/**
 * Reconciling Engine B's legs against what the broker actually holds.
 *
 * This is what `recoveryComplete` means, and the reason it must never be a
 * constant: until this has run against a broker snapshot, a leg marked
 * UNKNOWN might be a live position, and submitting a new signal could
 * duplicate it. So the flag is written here, by a pass that did the work, and
 * the execution path reads it.
 *
 * ## The rule that shapes everything below
 *
 * **A position missing from a snapshot is not a closure.**
 *
 * An incomplete snapshot — a query that failed, a terminal that answered
 * partially, a reconnect mid-read — looks exactly like an account with no
 * positions. Treating absence as closure would mark live positions closed,
 * free the signal group, and let a second signal trade on top of the first.
 * So the collector states explicitly whether its snapshot was COMPLETE, and
 * closure is only ever concluded from a complete one.
 *
 * ## Matching a position to a leg
 *
 * Several Telegram legs share one magic number, by design — that is what
 * makes them independent positions. So the magic alone cannot say WHICH leg a
 * position is; the idempotency tag carried in the order comment does. A
 * Telegram-magic position whose comment does not match any known leg is
 * reported as UNRESOLVED and blocks recovery rather than being adopted: an
 * unattributable position is the one case where guessing could make this
 * engine manage a position it did not open.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { tagFromComment } from './idempotency';
import { isOwnedByTelegramEngine } from './ownership';
import { TELEGRAM_SPEC } from './spec';
import { TelegramEngineNotificationService } from './notifications/notification.service';
import { positionClosedMessage, reconciliationIncidentMessage } from './notifications/messages';

/**
 * How long a leg may sit PENDING, measured from publication, before a
 * complete snapshot showing nothing at the broker is taken as proof it was
 * never sent.
 *
 * Deliberately an order of magnitude beyond the 60-second lifetime: a leg
 * that is merely slow must never be closed out by this, and the only cost of
 * waiting longer is that Engine B stays blocked a little longer in a case
 * that needs an operator's attention anyway.
 */
export const ABANDONED_PENDING_LEG_MS = 10 * TELEGRAM_SPEC.maxSignalAgeMs;

/** One position as the broker reports it. */
export interface BrokerPosition {
  readonly ticket: string;
  readonly magic: number | null;
  readonly symbol: string;
  readonly comment: string | null;
  readonly volume: number;
  readonly openPrice: number | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly profit: number | null;
}

/** One closed deal, used to establish realised result. */
export interface BrokerDeal {
  readonly ticket: string;
  readonly positionId: string | null;
  readonly magic: number | null;
  readonly comment: string | null;
  readonly profit: number;
  readonly closedAtMs: number | null;
}

export interface ReconciliationInput {
  readonly accountId: string;
  readonly nowMs: number;
  /**
   * Whether the collector could enumerate the account COMPLETELY. False means
   * no closure may be concluded from this pass, whatever it appears to show.
   */
  readonly snapshotComplete: boolean;
  readonly snapshotAtMs: number;
  readonly positions: readonly BrokerPosition[];
  readonly deals: readonly BrokerDeal[];
}

export interface ReconciliationOutcome {
  readonly recoveryComplete: boolean;
  readonly resolvedUnknown: number;
  readonly closedLegs: number;
  readonly unresolvedLegs: number;
  readonly foreignTelegramPositions: readonly string[];
  readonly detail: string;
}

@Injectable()
export class TelegramReconciliationService {
  private readonly logger = new Logger(TelegramReconciliationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Optional() private readonly notifier?: TelegramEngineNotificationService,
  ) {}

  /** Fire-and-forget: alerting is downstream of the record, never a gate. */
  private announce(eventType: string, dedupKey: string, text: string, audience: 'TRADING' | 'OPS' = 'TRADING'): void {
    void this.notifier?.notify(eventType, dedupKey, text, audience).catch(() => undefined);
  }

  async reconcile(input: ReconciliationInput): Promise<ReconciliationOutcome> {
    const { accountId, nowMs } = input;

    // Only this engine's positions are considered, and only by magic number.
    // Engine A's M1/M5 positions, other bots' and manual trades are outside
    // this pass entirely — not filtered late, but never selected.
    const ours = input.positions.filter((p) => isOwnedByTelegramEngine(p.magic));

    const byTag = new Map<string, BrokerPosition>();
    const untagged: BrokerPosition[] = [];
    for (const position of ours) {
      const tag = tagFromComment(position.comment);
      if (tag) byTag.set(tag, position);
      else untagged.push(position);
    }

    // Legs that could still correspond to something at the broker. A SKIPPED
    // or FAILED leg provably opened nothing and needs no reconciling.
    const legs = await this.prisma.telegramSignalLeg.findMany({
      where: { signal: { accountId }, orderStatus: { in: ['PENDING', 'UNKNOWN', 'FILLED'] } },
      include: { signal: { select: { accountId: true, publishedAt: true, messageId: true } } },
    });

    let resolvedUnknown = 0;
    let closedLegs = 0;
    let unresolvedLegs = 0;

    for (const leg of legs) {
      const position = byTag.get(leg.idempotencyTag);

      if (position) {
        // It exists at the broker. An UNKNOWN leg is now known: it filled.
        if (leg.orderStatus !== 'FILLED') {
          await this.prisma.telegramSignalLeg.update({
            where: { id: leg.id },
            data: {
              orderStatus: 'FILLED',
              ticket: BigInt(position.ticket),
              fillPrice: position.openPrice ?? leg.fillPrice,
              brokerStopLoss: position.stopLoss ?? leg.brokerStopLoss,
              brokerTakeProfit: position.takeProfit ?? leg.brokerTakeProfit,
              filledAt: leg.filledAt ?? new Date(nowMs),
              reconciledAt: new Date(nowMs),
              failureReason: null,
            },
          });
          resolvedUnknown += 1;
          this.logger.warn(
            `telegram leg ${leg.legIndex} of signal ${leg.signalId} was ${leg.orderStatus} and IS live at the ` +
              `broker (ticket ${position.ticket}). Recorded as FILLED; it is not re-sent.`,
          );
        } else {
          await this.prisma.telegramSignalLeg.update({
            where: { id: leg.id },
            data: { reconciledAt: new Date(nowMs) },
          });
        }
        // A position that is unprotected at the broker is an incident,
        // whenever it is noticed, not only at fill time.
        if (position.stopLoss === null || position.stopLoss === 0) {
          await this.prisma.telegramSignalLeg.update({
            where: { id: leg.id },
            data: {
              protectionIncident:
                `Broker reports no stop loss on live ticket ${position.ticket}. The position is unprotected and ` +
                'needs an operator; this engine does not silently re-attach a level it cannot verify.',
            },
          });
        }
        continue;
      }

      // Not open at the broker. Whether that is a closure depends entirely on
      // whether the snapshot was complete.
      if (!input.snapshotComplete) {
        unresolvedLegs += 1;
        continue;
      }

      const deal = this.findDeal(input.deals, leg.idempotencyTag, leg.ticket ? String(leg.ticket) : null);
      if (deal) {
        await this.prisma.telegramSignalLeg.update({
          where: { id: leg.id },
          data: {
            closureComplete: true,
            closedAt: deal.closedAtMs ? new Date(deal.closedAtMs) : new Date(nowMs),
            realizedPl: deal.profit,
            reconciledAt: new Date(nowMs),
            orderStatus: leg.orderStatus === 'UNKNOWN' ? 'FILLED' : leg.orderStatus,
          },
        });
        closedLegs += 1;
        // The realised figure comes from the broker's own deal, never from
        // the published prices. A closure alert carrying a theoretical P/L is
        // a number someone will later reconcile against and find wrong.
        this.announce(
          'POSITION_CLOSED',
          `telegram:closed:${leg.id}`,
          positionClosedMessage({
            messageId: leg.signal.messageId,
            legIndex: leg.legIndex,
            legCount: await this.legCount(leg.signalId),
            direction: leg.direction,
            volumeLots: Number(leg.volumeLots),
            entryFill: leg.fillPrice === null ? null : Number(leg.fillPrice),
            exitPrice: null,
            stopLoss: Number(leg.stopLoss),
            takeProfit: Number(leg.takeProfit),
            realizedPl: deal.profit,
            ticket: leg.ticket === null ? null : String(leg.ticket),
          }),
        );
        continue;
      }

      if (leg.orderStatus === 'FILLED') {
        // It filled, it is gone from a COMPLETE snapshot, and no closing deal
        // was found. The position is closed but its result is unknown; that is
        // recorded as closure without a realised figure rather than inventing
        // one or leaving the leg looking live.
        await this.prisma.telegramSignalLeg.update({
          where: { id: leg.id },
          data: {
            closureComplete: true,
            closedAt: new Date(nowMs),
            reconciledAt: new Date(nowMs),
            failureReason:
              'Closed at the broker, but no matching deal was found, so the realised result could not be ' +
              'established from this snapshot.',
          },
        });
        closedLegs += 1;
        continue;
      }

      if (leg.orderStatus === 'UNKNOWN') {
        // A complete snapshot with no position and no deal is genuine
        // evidence the order never became one.
        await this.prisma.telegramSignalLeg.update({
          where: { id: leg.id },
          data: {
            orderStatus: 'FAILED',
            reconciledAt: new Date(nowMs),
            failureReason:
              'A complete broker snapshot shows neither a position nor a deal for this leg, so the submission ' +
              'never became a position.',
          },
        });
        resolvedUnknown += 1;
        continue;
      }

      // PENDING with nothing at the broker. Two very different situations
      // share this shape, and telling them apart matters:
      //
      //   in flight  — queued moments ago, the collector has it or is about
      //                to. Genuinely unresolved; recovery waits.
      //   abandoned  — the collector claimed it and then died, or the result
      //                report was lost. Nobody will ever report it.
      //
      // Left alone, the second case holds `recoveryComplete` false forever,
      // which permanently disables Engine B for a leg that provably cannot
      // exist: past its 60-second lifetime the collector refuses to send it,
      // and a complete snapshot shows no position and no deal for it. So a
      // leg older than the abandonment horizon is closed out here rather than
      // left to block the engine indefinitely.
      //
      // The horizon is far longer than the lifetime plus any plausible broker
      // acknowledgement delay, so a leg that is merely slow is never caught
      // by it.
      const ageMs = nowMs - leg.signal.publishedAt.getTime();
      if (ageMs > ABANDONED_PENDING_LEG_MS) {
        await this.prisma.telegramSignalLeg.update({
          where: { id: leg.id },
          data: {
            orderStatus: 'SKIPPED',
            skipReason: 'TELEGRAM_ABANDONED_BEFORE_SUBMISSION',
            reconciledAt: new Date(nowMs),
            failureReason:
              `The leg was still PENDING ${Math.round(ageMs / 1000)}s after publication, and a complete broker ` +
              'snapshot shows neither a position nor a deal for it. Past its 60-second lifetime it can no longer ' +
              'be sent, so it is closed out rather than holding recovery open forever.',
          },
        });
        this.logger.warn(
          `telegram leg ${leg.legIndex} of signal ${leg.signalId} was abandoned before submission and has been ` +
            'closed out. It was never sent.',
        );
        continue;
      }
      unresolvedLegs += 1;
    }

    // Telegram-magic positions that match no leg. Reported loudly and never
    // adopted: this engine manages only positions it can prove it opened.
    const foreign = untagged.map((p) => p.ticket);
    for (const position of untagged) {
      this.logger.error(
        `Broker position ${position.ticket} carries the Telegram magic number but no recognisable leg tag ` +
          `(comment: ${position.comment ?? 'none'}). It is NOT adopted and NOT managed. An operator must ` +
          'establish where it came from.',
      );
    }

    // Recovery is complete only when the snapshot was complete AND nothing is
    // left in an ambiguous state. Both conditions, because either one alone
    // permits trading on top of a position nobody has accounted for.
    const recoveryComplete = input.snapshotComplete && unresolvedLegs === 0 && foreign.length === 0;

    const detail = input.snapshotComplete
      ? `Complete snapshot at ${new Date(input.snapshotAtMs).toISOString()}: ${legs.length} leg(s) examined, ` +
        `${resolvedUnknown} resolved, ${closedLegs} closed, ${unresolvedLegs} unresolved, ` +
        `${foreign.length} unattributable Telegram-magic position(s).`
      : 'The broker snapshot was INCOMPLETE, so no closure was concluded from it and recovery is not complete. ' +
        'A missing position in an incomplete snapshot is not evidence of anything.';

    await this.prisma.telegramReconciliationState.upsert({
      where: { accountId },
      create: {
        accountId,
        recoveryComplete,
        lastCompletedAt: recoveryComplete ? new Date(nowMs) : null,
        brokerSnapshotAt: new Date(input.snapshotAtMs),
        unresolvedLegs,
        detail,
      },
      update: {
        recoveryComplete,
        // Only a completed pass moves this forward, so an operator can see
        // when recovery was last genuinely established rather than when it
        // was last attempted.
        ...(recoveryComplete ? { lastCompletedAt: new Date(nowMs) } : {}),
        brokerSnapshotAt: new Date(input.snapshotAtMs),
        unresolvedLegs,
        detail,
      },
    });

    if (!recoveryComplete) {
      this.logger.warn(`telegram recovery NOT complete: ${detail}`);
      // Only when something is genuinely wrong, not merely in flight: a leg
      // still on its way to the broker is normal and must not page anyone.
      if (foreign.length > 0 || !input.snapshotComplete) {
        this.announce(
          'RECONCILIATION_INCIDENT',
          // Keyed by the day and the shape of the problem, so a persistent
          // fault reports once rather than on every pass.
          `telegram:recon:${accountId}:${new Date(nowMs).toISOString().slice(0, 13)}:${foreign.length}:${input.snapshotComplete}`,
          reconciliationIncidentMessage(detail),
          'OPS',
        );
      }
    }

    return {
      recoveryComplete,
      resolvedUnknown,
      closedLegs,
      unresolvedLegs,
      foreignTelegramPositions: foreign,
      detail,
    };
  }

  /**
   * Finds the deal that closed a leg.
   *
   * By position id first, because that is the broker's own link between a
   * position and the deals that opened and closed it; by comment tag second,
   * for brokers that preserve comments onto deals. Both are evidence; neither
   * is guessed at from timing, which would happily match another engine's
   * deal that happened to land in the same second.
   */
  private async legCount(signalId: string): Promise<number> {
    return this.prisma.telegramSignalLeg.count({ where: { signalId } });
  }

  private findDeal(deals: readonly BrokerDeal[], tag: string, ticket: string | null): BrokerDeal | null {
    if (ticket) {
      const byPosition = deals.find((d) => d.positionId === ticket);
      if (byPosition) return byPosition;
    }
    const byTag = deals.find((d) => tagFromComment(d.comment) === tag);
    return byTag ?? null;
  }
}
