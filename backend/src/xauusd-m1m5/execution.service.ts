/**
 * Turning an approved candidate into a submitted order (§7, §8, §15.6).
 *
 * This is the only path from "the strategy decided" to "the broker has it",
 * and its shape is dictated by one question: **what happens if this process
 * dies at each step?**
 *
 * The ordering below answers that. Every step is durable before the step that
 * depends on it, so a crash leaves a recoverable record rather than an
 * untracked position:
 *
 *   1. record the decision          — durable, before anything is claimed
 *   2. claim the timeframe          — atomic; losing the race ends here
 *   3. re-check risk and pre-send   — cheap, and the world has moved on
 *   4. mark SENT                    — durable, BEFORE the broker call
 *   5. hand to the broker
 *   6. record the outcome           — FILLED, FAILED, or UNKNOWN
 *
 * Step 4 is the one that matters most and looks the most redundant. Marking
 * SENT *before* the submission means a crash between 4 and 6 leaves a row
 * saying "we may have sent this", which reconciliation can resolve against
 * broker state. Marking it after would leave a row saying "we never sent it"
 * next to a real position — and the slot would be released, permitting a
 * second.
 *
 * ## Nothing here approves a trade
 *
 * §8 of the operator brief is explicit: there is no manual approval per trade,
 * and AI, Telegram and the dashboard must not approve trades. They are not
 * consulted here, and there is no hook for them to be. The only things that
 * can stop a submission are the deterministic gates — schedule, occupancy,
 * post-loss locks, risk, quote freshness, drift and MT5 permissions.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { bracketsFor, type BrokerStopConstraints } from './brackets';
import type { CrossingSignal } from './crossing';
import { isSubmissionEnabled, entriesBlockedByControls, getM1M5ExecutionMode } from './controls';
import { lockoutReasonFor } from './locks';
import { M1M5OccupancyService } from './occupancy.service';
import { evaluateRisk, preSendCheck, type AccountRiskState, type CommittedRisk } from './risk';
import { evaluateReadiness, type Mt5PermissionSnapshot } from './mt5-readiness';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from './spec';
import { v2MagicForTimeframe } from './safety-constants';
import { resolveVolume, validateVolume } from './volume';

export type ExecutionOutcome =
  | 'SUBMITTED'
  /** Handed to the collector queue; the broker outcome is not known yet. */
  | 'QUEUED'
  | 'SKIPPED_OCCUPIED'
  /** A post-loss lock is active for this timeframe and direction (§6). */
  | 'SKIPPED_LOCKED'
  /** This exact crossing already produced a decision; it is never submitted twice. */
  | 'SKIPPED_DUPLICATE'
  | 'REFUSED_RISK'
  | 'REFUSED_PRE_SEND'
  | 'REFUSED_MT5_NOT_READY'
  | 'REFUSED_BRACKETS'
  | 'REFUSED_VOLUME'
  | 'NOT_SUBMITTING_MODE';

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  readonly decisionId: string | null;
  readonly detail: string;
}

/** What the broker hand-off needs, injected so this is testable without one. */
export interface SubmitRequest {
  readonly decisionId: string;
  readonly timeframe: Timeframe;
  readonly direction: 'BUY' | 'SELL';
  readonly volumeLots: number;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly magicNumber: number;
}

export interface SubmitResponse {
  readonly status: 'FILLED' | 'FAILED' | 'UNKNOWN' | 'QUEUED';
  readonly ticket?: string;
  readonly fillPrice?: number;
  readonly brokerStopLoss?: number;
  readonly brokerTakeProfit?: number;
  readonly error?: string;
}

/**
 * The broker hand-off. In production this queues the order for the collector
 * to place; in tests it is a simulated broker.
 */
export interface BrokerPort {
  submit(request: SubmitRequest): Promise<SubmitResponse>;
}

export interface ExecutionContext {
  readonly accountId: string;
  readonly signal: CrossingSignal;
  readonly nowMs: number;
  readonly freshQuote: { bid: number; ask: number; tickAtMs: number };
  readonly constraints: BrokerStopConstraints;
  readonly account: AccountRiskState;
  readonly committed: readonly CommittedRisk[];
  readonly marginRequired: number;
  /** Account-currency loss if this candidate hits its stop. */
  readonly stopRisk: number;
  readonly mt5Snapshot: Mt5PermissionSnapshot | null;
  readonly expectedLoginId: string | null;
  readonly scheduleAllowsEntries: boolean;
  readonly scheduleDetail: string;
  readonly configuredVolume: string | number | null;
}

@Injectable()
export class M1M5ExecutionService {
  private readonly logger = new Logger(M1M5ExecutionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly occupancy: M1M5OccupancyService,
    @Inject('M1M5_BROKER_PORT') private readonly broker: BrokerPort,
  ) {}

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { signal, accountId } = ctx;
    const magicNumber = v2MagicForTimeframe(signal.timeframe);

    // --- MT5 readiness, before anything durable is written. Fresh quotes are
    // not permission to trade, so this is checked explicitly every time.
    const readiness = evaluateReadiness({
      snapshot: ctx.mt5Snapshot,
      expectedLoginId: ctx.expectedLoginId,
      nowMs: ctx.nowMs,
    });
    if (!readiness.ready) {
      return {
        outcome: 'REFUSED_MT5_NOT_READY',
        decisionId: null,
        detail: `MT5 is not ready to trade: ${readiness.blockers.map((b) => b.code).join(', ')}.`,
      };
    }

    // --- Volume, resolved and validated against the live contract. Never
    // resized to fit: §7 forbids it, and a silently smaller order is a
    // different trade than the one risk approved.
    const volume = resolveVolume(ctx.configuredVolume);
    const volumeCheck = validateVolume(volume.lots, {
      min: ctx.constraints.tickSize > 0 ? 0.01 : 0.01,
      max: 100,
      step: 0.01,
    });
    if (!volumeCheck.acceptable) {
      return { outcome: 'REFUSED_VOLUME', decisionId: null, detail: volumeCheck.reason ?? 'volume refused' };
    }

    // --- Brackets from the same quote everything else uses.
    const bracketResult = bracketsFor(signal.direction, ctx.freshQuote, ctx.constraints);
    if (bracketResult.brackets === null) {
      return {
        outcome: 'REFUSED_BRACKETS',
        decisionId: null,
        detail: bracketResult.detail ?? 'brackets refused',
      };
    }
    const brackets = bracketResult.brackets;

    // --- Risk, across BOTH timeframes including reserved-but-unfilled.
    const risk = evaluateRisk({
      account: ctx.account,
      candidateStopRisk: ctx.stopRisk,
      candidateMarginRequired: ctx.marginRequired,
      committed: ctx.committed,
    });

    // --- 1. Record the decision FIRST, whatever happens next. A skipped or
    // refused signal is as much a part of the audit trail as a submitted one
    // (§12), and writing it before the claim means a crash mid-claim still
    // leaves evidence that the signal existed.
    // --- Post-loss lock, read from the DATABASE, which is its source of truth.
    // Independent of the observation loop's own lock check, so an entry into a
    // locked direction would need both to fail. This check did not exist, and
    // the loop's in-memory locks were never loaded from the database: after a
    // real losing trade locked M1 SELL, further M1 SELL signals reached the
    // risk gate and were stopped only because their size exceeded the cap.
    const locked = await this.occupancy.isLocked(accountId, signal.timeframe, signal.direction);

    let decision;
    try {
      decision = await this.prisma.xauusdM1M5Decision.create({
        data: {
          // When the scheduler's cycle formed this crossing: the start of the
          // execution timeline (see execution-latency.ts).
          detectedAt: new Date(ctx.nowMs),
          strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
          specHash: SPEC_HASH,
          accountId,
          timeframe: signal.timeframe,
          direction: signal.direction,
          observedAt: new Date(signal.observedAt),
          eventId: signal.signalId,
          rsiValue: signal.rsi,
          previousRsi: signal.previousRsi,
          threshold: signal.threshold,
          basisPrice: signal.price,
          observationMode: 'TICK',
          entryPrice: brackets.entryPrice,
          stopLoss: brackets.stopLoss,
          takeProfit: brackets.takeProfit,
          volumeLots: volume.lots,
          magicNumber,
          reasoning:
            `${signal.timeframe} ${signal.direction}: RSI crossed ${signal.threshold} ` +
            `(${signal.previousRsi} -> ${signal.rsi}).`,
          // Spread into plain objects rather than passing the readonly
          // interfaces directly: Prisma's Json input type requires an index
          // signature, which a readonly interface does not have.
          evidence: {
            signal: {
              signalId: signal.signalId,
              timeframe: signal.timeframe,
              direction: signal.direction,
              rsi: signal.rsi,
              previousRsi: signal.previousRsi,
              threshold: signal.threshold,
              price: signal.price,
              observedAt: signal.observedAt,
            },
            volume: { lots: volume.lots, source: volume.source, provenance: volume.provenance },
            risk: { ...risk.evidence },
            brackets: {
              entryPrice: brackets.entryPrice,
              stopLoss: brackets.stopLoss,
              takeProfit: brackets.takeProfit,
              takeProfitDistance: brackets.takeProfitDistance,
              stopLossDistance: brackets.stopLossDistance,
            },
            mt5: { ready: readiness.ready, hedgingSupported: readiness.hedgingSupported },
            executionMode: getM1M5ExecutionMode(),
          },
          approved: !locked && risk.approved,
          // The lock takes precedence: a locked direction is recorded as locked,
          // whatever risk would also have said about it.
          skipReason: locked ? lockoutReasonFor(signal.direction) : risk.approved ? null : risk.refusal,
        },
      });
    } catch (err) {
      // The unique (accountId, strategyVersion, eventId) constraint IS the
      // crossing's identity. A second evaluation of the same crossing -- a
      // retried cycle, a restart mid-cycle -- lands here, and must produce no
      // second order attempt. It used to surface as a cycle error; it is a
      // normal, expected outcome and is reported as one.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return {
          outcome: 'SKIPPED_DUPLICATE',
          decisionId: null,
          detail: `${signal.timeframe} ${signal.direction} crossing ${signal.signalId} already has a decision; not submitted again.`,
        };
      }
      throw err;
    }

    if (locked) {
      return {
        outcome: 'SKIPPED_LOCKED',
        decisionId: decision.id,
        detail:
          `${signal.timeframe} ${signal.direction} is locked after a realized loss (${lockoutReasonFor(signal.direction)}). ` +
          'The signal is recorded and consumed; nothing is sent.',
      };
    }

    if (!risk.approved) {
      return { outcome: 'REFUSED_RISK', decisionId: decision.id, detail: risk.detail ?? 'risk refused' };
    }

    // --- 2. Claim the timeframe. Atomic; losing the race ends here, and the
    // signal is consumed rather than queued (§4).
    const claim = await this.occupancy.claim(accountId, signal.timeframe, decision.id);
    if (!claim.claimed) {
      await this.prisma.xauusdM1M5Decision.update({
        where: { id: decision.id },
        data: { approved: false, skipReason: 'TIMEFRAME_OCCUPIED' },
      });
      return { outcome: 'SKIPPED_OCCUPIED', decisionId: decision.id, detail: claim.reason };
    }

    // --- 3. The final gate, immediately before the broker call. Time has
    // passed since the decision; the schedule, the quote and the drift may all
    // have changed, and §9.2 requires the boundary be rechecked here.
    const preSend = preSendCheck({
      timeframe: signal.timeframe,
      direction: signal.direction,
      signalObservedAtMs: signal.observedAt,
      signalPrice: signal.price,
      freshQuote: ctx.freshQuote,
      entryPrice: brackets.entryPrice,
      stopLoss: brackets.stopLoss,
      takeProfit: brackets.takeProfit,
      pointSize: ctx.constraints.pointSize,
      nowMs: ctx.nowMs,
      scheduleAllowsEntries: ctx.scheduleAllowsEntries,
      scheduleDetail: ctx.scheduleDetail,
      entriesBlockedReason: entriesBlockedByControls(),
    });
    if (!preSend.ok) {
      // Never sent, so the slot is genuinely free again.
      await this.occupancy.releaseUnsent(accountId, signal.timeframe, decision.id);
      await this.prisma.xauusdM1M5Decision.update({
        where: { id: decision.id },
        data: { approved: false, skipReason: preSend.refusal },
      });
      return { outcome: 'REFUSED_PRE_SEND', decisionId: decision.id, detail: preSend.detail ?? 'pre-send refused' };
    }

    // SHADOW runs everything above and stops here, so a shadow run exercises
    // exactly the same gates a live one would.
    if (!isSubmissionEnabled()) {
      await this.occupancy.releaseUnsent(accountId, signal.timeframe, decision.id);
      await this.prisma.xauusdM1M5Decision.update({
        where: { id: decision.id },
        data: { approved: false, skipReason: `NOT_SUBMITTING_MODE_${getM1M5ExecutionMode()}` },
      });
      return {
        outcome: 'NOT_SUBMITTING_MODE',
        decisionId: decision.id,
        detail: `Execution mode is ${getM1M5ExecutionMode()}; every gate passed but no order was queued.`,
      };
    }

    // --- 4. Durable BEFORE the broker call. See the header.
    await this.prisma.xauusdM1M5Decision.update({
      where: { id: decision.id },
      data: { orderStatus: 'PENDING', sentAt: new Date(ctx.nowMs) },
    });
    await this.occupancy.advance(accountId, signal.timeframe, 'SENT');

    // --- 5 and 6. Submit, then record whatever came back — including "we do
    // not know", which is a real outcome and must never be flattened into
    // FAILED. An UNKNOWN keeps the slot held until reconciliation resolves it.
    let response: SubmitResponse;
    try {
      response = await this.broker.submit({
        decisionId: decision.id,
        timeframe: signal.timeframe,
        direction: signal.direction,
        volumeLots: volume.lots,
        entryPrice: brackets.entryPrice,
        stopLoss: brackets.stopLoss,
        takeProfit: brackets.takeProfit,
        magicNumber,
      });
    } catch (err) {
      response = { status: 'UNKNOWN', error: (err as Error).message };
    }

    // A queueing port has handed the order to the collector but cannot know
    // the broker's answer yet, so there is nothing to record and nothing to
    // overwrite. The row deliberately stays PENDING: that is what the
    // collector's poll selects on, and flattening it into UNKNOWN here would
    // both lose the order and misreport a hand-off that went fine.
    //
    // The slot stays held at SENT. That over-states reality by however long
    // the order waits in the queue, and it does so in the safe direction: a
    // slot held too eagerly blocks a second entry, while a slot freed too
    // eagerly permits one.
    if (response.status === 'QUEUED') {
      return {
        outcome: 'QUEUED',
        decisionId: decision.id,
        detail:
          `${signal.timeframe} ${signal.direction} handed to the collector queue. ` +
          'The slot stays held until the collector reports the broker outcome.',
      };
    }

    await this.prisma.xauusdM1M5Decision.update({
      where: { id: decision.id },
      data: {
        orderStatus: response.status,
        ticket: response.ticket ? BigInt(response.ticket) : null,
        fillPrice: response.fillPrice ?? null,
        brokerStopLoss: response.brokerStopLoss ?? null,
        brokerTakeProfit: response.brokerTakeProfit ?? null,
        filledAt: response.status === 'FILLED' ? new Date() : null,
        failureReason: response.error ?? null,
      },
    });

    if (response.status === 'FILLED') {
      await this.occupancy.advance(accountId, signal.timeframe, 'FILLED');
    } else if (response.status === 'UNKNOWN') {
      // Held, not released. It may already be a live position.
      await this.occupancy.advance(accountId, signal.timeframe, 'UNKNOWN');
    } else {
      // A broker-confirmed refusal is the only case where releasing is safe.
      await this.occupancy.releaseUnsent(accountId, signal.timeframe, decision.id);
    }

    return {
      outcome: 'SUBMITTED',
      decisionId: decision.id,
      detail: `${signal.timeframe} ${signal.direction} submitted: broker reported ${response.status}.`,
    };
  }
}
