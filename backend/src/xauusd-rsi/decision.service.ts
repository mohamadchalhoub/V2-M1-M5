/**
 * Atomic claim and durable result recording for queued XAUUSD RSI orders,
 * plus the final pre-send re-verification.
 *
 * Two separate concerns deliberately kept in one place because they share the
 * same invariant: a decision is claimed exactly once, and whatever happens
 * after the claim is recorded durably, including "we do not know".
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RsiAccountStateService } from './account-state.service';
import { entriesBlockedByControls } from './controls';
import { evaluateEntryEligibility } from './schedule';
import type { RuleFamily } from './pattern';
import {
  RSI_GOLD_POINT_SIZE,
  RSI_MAX_ENTRY_DEVIATION_POINTS,
  RSI_MAX_SIGNAL_AGE_SECONDS,
  RSI_QUOTE_MAX_STALENESS_SECONDS,
  RSI_SYMBOL,
  rsiMagicForFamily,
} from './safety-constants';

export interface RsiExecutionResult {
  ok: boolean;
  ticket?: number | null;
  filledPrice?: number | null;
  /** SL/TP the broker actually reports on the resulting position. */
  brokerStopLoss?: number | null;
  brokerTakeProfit?: number | null;
  errorMessage?: string | null;
  /** True when the broker's response was lost or ambiguous — outcome genuinely unknown. */
  uncertain?: boolean;
}

export interface RsiPreSendCheckResult {
  ok: boolean;
  reason: string | null;
}

@Injectable()
export class RsiDecisionService {
  private readonly logger = new Logger(RsiDecisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: RsiAccountStateService,
  ) {}

  /**
   * Atomic PENDING -> SENT claim. The conditional `updateMany` is what makes
   * it safe: two concurrent pollers both read the same candidate, but only
   * one update matches a row still in PENDING, and the loser gets null.
   */
  async claimOldestPendingOrder(accountId: string) {
    const candidate = await this.prisma.xauusdRsiDecision.findFirst({
      where: { accountId, symbol: RSI_SYMBOL, orderStatus: 'PENDING' },
      orderBy: { evaluatedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.xauusdRsiDecision.updateMany({
      where: { id: candidate.id, orderStatus: 'PENDING' },
      data: { orderStatus: 'SENT' },
    });
    if (claimed.count === 0) return null;

    return candidate;
  }

  /**
   * Records the broker's reported outcome.
   *
   * An uncertain result becomes `UNKNOWN`, never `FAILED`: a lost response
   * does not mean the order did not reach the broker, and treating it as a
   * failure would free the occupancy slot for a second position while the
   * first may well be open. `UNKNOWN` keeps the slot occupied until
   * reconciliation against real broker state resolves it.
   */
  async recordExecutionResult(decisionId: string, result: RsiExecutionResult): Promise<void> {
    const requested = await this.prisma.xauusdRsiDecision.findUnique({ where: { id: decisionId } });
    const requestedPrice = requested?.requestedPrice?.toNumber() ?? requested?.entryPrice?.toNumber() ?? null;
    const filledPrice = result.filledPrice ?? null;
    const slippagePoints =
      requestedPrice !== null && filledPrice !== null
        ? Math.abs(filledPrice - requestedPrice) / RSI_GOLD_POINT_SIZE
        : null;

    const orderStatus = result.uncertain ? 'UNKNOWN' : result.ok ? 'FILLED' : 'FAILED';

    // Slot handling, by outcome:
    //   FAILED  — the broker definitely refused, so nothing was opened and the
    //             family's slot is free again immediately.
    //   UNKNOWN — the outcome is genuinely unknown, so the slot STAYS held.
    //             Releasing it would let a second position open while the
    //             first may well be live at the broker.
    //   FILLED  — a position now exists; the slot stays held until
    //             reconciliation observes that position is gone.
    const slotReleasedAt = orderStatus === 'FAILED' ? new Date() : null;

    await this.prisma.xauusdRsiDecision.update({
      where: { id: decisionId },
      data: {
        orderStatus,
        mt5Ticket: result.ticket ?? null,
        filledPrice,
        slippagePoints,
        brokerStopLoss: result.brokerStopLoss ?? null,
        brokerTakeProfit: result.brokerTakeProfit ?? null,
        filledAt: result.ok && !result.uncertain ? new Date() : null,
        executionError: result.errorMessage ?? null,
        slotReleasedAt,
      },
    });
    this.logger.log(`decision ${decisionId}: ${orderStatus}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`);
  }

  /**
   * Resolves an in-flight decision that never received its broker ticket.
   *
   * This exists because of a real incident. Decision
   * `966bf32f-04f2-4f4c-8715-699e072e2b7a` was submitted, the broker filled
   * it as ticket 58537207521, and the collector reported that fill — but the
   * backend's own write failed, because `mt5_ticket` was INT4 and an 11-digit
   * ticket does not fit in 32 bits. The decision was left SENT with a null
   * ticket. The column is BIGINT now, so that specific cause is gone, but
   * ANY lost or rejected result report leaves the same shape behind, and the
   * consequence was severe: a null ticket meant the slot could never be
   * released, so the RETEST family was blocked permanently.
   *
   * The order's broker comment is what makes recovery possible without
   * guessing. Submission stamps every order with `rsi-<first 8 of decision
   * id>` (see `execution.controller.ts`), so a position carries the identity
   * of the decision that opened it. Matching additionally requires the same
   * account, symbol and rule-family magic number, so a coincidental comment
   * cannot attach a foreign position to this strategy.
   *
   * Attribution alone never releases anything. It only supplies the ticket;
   * closure is then judged by `releaseSlotsForClosedPositions` on its own
   * evidence.
   */
  private async attributeTicketlessHolders(accountId: string): Promise<string[]> {
    const orphans = await this.prisma.xauusdRsiDecision.findMany({
      where: {
        accountId,
        slotReleasedAt: null,
        mt5Ticket: null,
        orderStatus: { in: ['SENT', 'UNKNOWN'] },
      },
      select: { id: true, ruleFamily: true, orderStatus: true, direction: true, volumeLots: true, requestedPrice: true, executionError: true },
    });
    if (orphans.length === 0) return [];

    const notes: string[] = [];
    for (const orphan of orphans) {
      const expectedComment = `rsi-${orphan.id.slice(0, 8)}`;
      const expectedMagic = rsiMagicForFamily(orphan.ruleFamily as RuleFamily);

      const candidates = await this.prisma.position.findMany({
        where: { accountId, symbol: RSI_SYMBOL },
        select: { externalPositionId: true, status: true, volume: true, openPrice: true, stopLoss: true, takeProfit: true, rawPayload: true },
      });
      const match = candidates.find((c) => {
        const raw = c.rawPayload as Record<string, unknown> | null;
        return raw?.comment === expectedComment && Number(raw?.magic) === expectedMagic;
      });
      if (!match) {
        // No broker evidence either way. The decision keeps its slot: an
        // unattributable in-flight order is exactly the case where holding
        // is the safe answer.
        continue;
      }

      await this.prisma.xauusdRsiDecision.update({
        where: { id: orphan.id },
        data: {
          mt5Ticket: BigInt(match.externalPositionId),
          orderStatus: 'FILLED',
          filledPrice: match.openPrice,
          brokerStopLoss: match.stopLoss,
          brokerTakeProfit: match.takeProfit,
          slippagePoints:
            match.openPrice !== null && orphan.requestedPrice !== null
              ? Math.abs(match.openPrice.toNumber() - orphan.requestedPrice.toNumber()) / RSI_GOLD_POINT_SIZE
              : null,
          executionError:
            (orphan.executionError ? `${orphan.executionError} | ` : '') +
            `Reconciled against broker evidence: this ${orphan.orderStatus} decision had no ticket, and the broker reports position ${match.externalPositionId} opened under this strategy's comment "${expectedComment}" and magic ${expectedMagic}. The result report was lost or rejected at the time.`,
        },
      });
      notes.push(`attributed ${orphan.ruleFamily} decision ${orphan.id} to broker position ${match.externalPositionId}`);
      this.logger.warn(
        `decision ${orphan.id} had no ticket but the broker shows position ${match.externalPositionId} with comment ${expectedComment} and magic ${expectedMagic} — attributed and marked FILLED`,
      );
    }
    return notes;
  }

  /**
   * Releases the slot of any holder whose position the broker confirms is
   * fully closed.
   *
   * Closure must be POSITIVE evidence, never absence. Specifically:
   *
   *   - A position row that the collector has marked CLOSED releases the
   *     slot. That marking is broker-derived: `positions_get()` is
   *     authoritative for what is open, and `replaceOpenPositions` marks
   *     anything missing from that authoritative list as closed, in one
   *     transaction.
   *   - A position still OPEN holds the slot regardless of its volume. A
   *     partial close leaves real exposure behind, and real exposure keeps
   *     its family.
   *   - NO position row at all does NOT release. That is absence, not
   *     evidence: a snapshot that never arrived, or one lost to a failed
   *     sync, must not be read as "the trade is over".
   *
   * `liveTickets` is still honoured as a second, independent confirmation:
   * a ticket the broker currently reports as open always holds its slot,
   * whatever a stored row says.
   */
  async releaseSlotsForClosedPositions(accountId: string, liveTickets: ReadonlySet<string>): Promise<string[]> {
    const released: string[] = [...(await this.attributeTicketlessHolders(accountId))];

    const holders = await this.prisma.xauusdRsiDecision.findMany({
      where: { accountId, slotReleasedAt: null, orderStatus: 'FILLED' },
      select: { id: true, mt5Ticket: true, ruleFamily: true },
    });
    for (const h of holders) {
      if (h.mt5Ticket === null) continue;
      const ticket = String(h.mt5Ticket);
      // Still open at the broker right now: nothing to decide.
      if (liveTickets.has(ticket)) continue;

      const position = await this.prisma.position.findFirst({
        where: { accountId, externalPositionId: ticket },
        select: { status: true, volume: true },
      });
      if (!position) {
        this.logger.warn(
          `decision ${h.id} holds the ${h.ruleFamily} slot on ticket ${ticket}, which is absent from both live broker data and stored positions — NOT releasing, because absence is not proof of closure`,
        );
        continue;
      }
      if (position.status !== 'CLOSED') {
        // Present but not closed — e.g. a partial close leaving exposure.
        continue;
      }

      await this.prisma.xauusdRsiDecision.update({
        where: { id: h.id },
        data: { slotReleasedAt: new Date() },
      });
      released.push(`${h.ruleFamily}:${ticket}`);
      this.logger.log(
        `released the ${h.ruleFamily} slot: the broker confirms position ${ticket} is fully closed`,
      );
    }
    return released;
  }

  /** Marks a claimed decision as never-sent, with the reason it was cancelled. */
  async cancelClaimed(decisionId: string, reason: string): Promise<void> {
    await this.prisma.xauusdRsiDecision.update({
      where: { id: decisionId },
      // Never sent, so the family's slot is released along with the cancel.
      data: { orderStatus: 'NONE', approved: false, skipReason: reason, executionError: null, slotReleasedAt: new Date() },
    });
    this.logger.warn(`decision ${decisionId} cancelled at pre-send: ${reason}`);
  }

  /**
   * The final gate, run AFTER the atomic claim but BEFORE the order is handed
   * to the collector.
   *
   * The claim proves only that nobody else took this row. It says nothing
   * about whether the schedule, the controls, the price or the occupancy are
   * still valid after however long the row sat PENDING plus the collector's
   * own poll delay. Spec §9.2 is explicit that the Friday cutoff must be
   * rechecked "at the actual submission boundary" — this is that boundary.
   *
   * "Now" is taken from the freshest live quote rather than the process
   * clock, so a stale or absent feed fails the check for an honest reason
   * instead of passing against a running clock with dead market data behind it.
   */
  async preSendCheck(params: {
    decisionId: string;
    accountId: string;
    action: 'OPEN_BUY' | 'OPEN_SELL';
    entryPrice: number;
    observedAtT: number;
    /** Which slot this decision holds — occupancy is rechecked for that family only. */
    family: RuleFamily;
  },
  /**
   * The server instant this check is evaluated at. Explicit so the quote's
   * age and the schedule are judged against ONE stated time rather than
   * against whatever timestamp happened to arrive with the data. Defaults
   * to now; production never supplies it, and it is never taken from a
   * request.
   */
  now: Date = new Date()): Promise<RsiPreSendCheckResult> {
    const { decisionId, accountId, action, entryPrice, observedAtT, family } = params;

    const controlBlock = entriesBlockedByControls();
    if (controlBlock) {
      return { ok: false, reason: `Refusing to send at the final pre-send check — ${controlBlock}` };
    }

    // The SAME selected quote the rest of the system uses, so the age check
    // and the deviation check below refer to one observation.
    //
    // This previously read `live_ticks` directly. That row is written once
    // per collector snapshot cycle and lags 25-45s, so after the
    // eligibility gate began judging freshness on the faster stream, a
    // signal could pass eligibility and then be refused here for a stale
    // quote — and the deviation check compared an entry priced off the fast
    // stream against a price up to 45s older. Both halves now come from the
    // same resolved quote.
    const resolution = await this.accountState.resolveQuoteNow(now);
    if (resolution.quote === null) {
      return { ok: false, reason: `${resolution.blockedReason} Refusing to send blind.` };
    }
    const quote = resolution.quote;

    // The quote's own age, measured against WALL CLOCK.
    //
    // This check has to come first, and it has to use wall clock, because
    // everything below uses the quote's timestamp as the market clock. Before
    // it existed, a frozen feed froze "now" along with it: the same tick could
    // be re-read indefinitely and a signal would never appear to age, because
    // it was being compared against its own stopped clock. Re-reading a tick
    // never refreshes it — `tickAt` carries the broker's timestamp through
    // ingest unchanged — so the only thing needed to expose a frozen feed is
    // to compare that timestamp against real time, which is what this does.
    if (!quote.fresh) {
      return {
        ok: false,
        reason: `XAUUSD quote is ${quote.ageSeconds.toFixed(1)}s old at the pre-send check (limit ${RSI_QUOTE_MAX_STALENESS_SECONDS}s, source ${quote.source}) — refusing to price an entry off a stale quote.`,
      };
    }

    // Having proven the quote is no more than RSI_QUOTE_MAX_STALENESS_SECONDS
    // old, its timestamp is usable as the market clock for the schedule and
    // signal-age checks below: the two clocks can now differ by at most that
    // bound, which is immaterial against a minute-granularity schedule and a
    // 60s signal limit. This is a bounded, stated approximation rather than an
    // assumption — and it is only sound BECAUSE of the check above.
    //
    // It is still not the final word. The order travels to the collector after
    // this, which re-reads MT5 directly and applies its own age gate
    // immediately before order_send (collector/app/executor.py,
    // QUOTE_MAX_AGE_SECONDS). A one-second polling loop guarantees a
    // one-second READ, never a one-second-old market price.
    // The schedule is judged at the EVALUATION instant, not at the quote's
    // timestamp. Using the quote's time made the feed its own clock: while
    // it was frozen, "now" froze with it. The quote is separately proven to
    // be at most RSI_QUOTE_MAX_STALENESS_SECONDS old, so the two can differ
    // by no more than that.
    const nowT = now.getTime();

    const session = await this.accountState.resolveBrokerSessionOpen(new Date());
    const eligibility = evaluateEntryEligibility({
      utcMs: nowT,
      brokerSessionOpen: session.open,
      dataFresh: session.open === true,
      recoveryComplete: true,
      otherBlock: null,
    });
    if (!eligibility.entriesAllowed) {
      return {
        ok: false,
        reason: `Schedule/session no longer permits an entry at send time (${eligibility.blockReason}): ${eligibility.detail}`,
      };
    }

    const signalAgeSeconds = (nowT - observedAtT) / 1000;
    if (!Number.isFinite(observedAtT)) {
      return { ok: false, reason: 'Cannot verify signal freshness at send time — the observation timestamp is missing. Refusing rather than assuming freshness.' };
    }
    if (signalAgeSeconds > RSI_MAX_SIGNAL_AGE_SECONDS) {
      return { ok: false, reason: `Signal is ${signalAgeSeconds.toFixed(1)}s old at send time (limit ${RSI_MAX_SIGNAL_AGE_SECONDS}s) — refusing to send a stale entry.` };
    }

    const currentExecutablePrice = action === 'OPEN_BUY' ? quote.ask : quote.bid;
    const deviationPoints = Math.abs(currentExecutablePrice - entryPrice) / RSI_GOLD_POINT_SIZE;
    if (deviationPoints > RSI_MAX_ENTRY_DEVIATION_POINTS) {
      return { ok: false, reason: `Executable price moved ${deviationPoints.toFixed(1)}pt since queuing (limit ${RSI_MAX_ENTRY_DEVIATION_POINTS}pt) — refusing to send, not chasing.` };
    }

    const occupancy = await this.accountState.resolveOccupancy(accountId, family, decisionId);
    if (occupancy.hasExistingXauusdExposure) {
      return { ok: false, reason: `Occupancy changed since queuing (${occupancy.exposureDescription}) — refusing to send.` };
    }

    const riskInfo = await this.accountState.resolveAccountRiskInfo(accountId);
    if (riskInfo.tradeMode !== 'DEMO') {
      return { ok: false, reason: `Account trade_mode is now "${riskInfo.tradeMode}", not DEMO — refusing to send. This is an absolute, non-negotiable safety rule.` };
    }

    return { ok: true, reason: null };
  }
}
