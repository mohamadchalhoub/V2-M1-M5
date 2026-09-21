import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isGoldKillSwitchActive } from './gold-kill-switch';
import { getGoldExecutionMode, isStopNewEntriesActive } from './gold-execution-mode';
import { GoldRuntimeSettingsService } from './gold-runtime-settings.service';
import { GoldAccountRiskInfo, GoldBrokerVolumeConstraints, GoldCandidateOrder, GoldOccupancyState, evaluateGoldRiskManager } from './gold-risk-manager';
import { GOLD_MAX_SIGNAL_AGE_SECONDS, GOLD_SYMBOL, GOLD_TP_SL_POINTS } from './gold-safety-constants';
import { beirutSecondsOfDay } from '../research/confirmed-retest-v2/time';
import { SPEC } from '../research/confirmed-retest-v2/spec';

export interface GoldSignal {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  /** The price the confirmed-retest-v2-derived event fired at. */
  signalEntryPrice: number;
  /** The freshest executable price available right now (bid/ask side matching `action`). */
  currentExecutablePrice: number;
  levelId: string;
  reasoning: string;
  /**
   * When the first-touch M1 candle CLOSED (the earliest instant the touch
   * was knowable) — NOT when this signal happens to be evaluated. Used to
   * enforce `GOLD_MAX_SIGNAL_AGE_SECONDS` so a touch discovered late (e.g.
   * after a collector/candle-sync stall) is never acted on as if it just
   * happened.
   */
  touchEndT: number;
}

export interface GoldCoordinatorContext {
  accountId: string;
  accountInfo: GoldAccountRiskInfo;
  occupancy: GoldOccupancyState;
  volumeConstraints: GoldBrokerVolumeConstraints;
  maxEntryDeviationPoints: number;
  goldPointSize: number;
  /** Wall-clock time of THIS evaluation — used to recheck the entry window and signal age live, immediately before submission, never assumed from the touch's own time. */
  nowT: number;
}

export interface GoldCoordinatorResult {
  mode: 'OFF' | 'SHADOW' | 'DEMO';
  stopNewEntriesActive: boolean;
  verdict: ReturnType<typeof evaluateGoldRiskManager> | null;
  queuedDecisionId: string | null;
}

/**
 * The mechanical-signal analog of `AutonomousExecutionCoordinatorService`
 * (which is AI-decision-driven, EURUSD-only): turns a confirmed-retest-v2-
 * derived gold event into either a queued PENDING order (DEMO mode only,
 * after the independent risk gate approves) or a logged-only decision
 * (SHADOW), or nothing at all (OFF). Deliberately has no scheduler of its
 * own, same deliberate posture as the EURUSD coordinator's own header
 * comment — something else must call `evaluate()` on a real signal; it is
 * never invoked speculatively or on a timer here.
 *
 * STOP NEW ENTRIES is re-read via `isStopNewEntriesActive()` a SECOND time,
 * immediately before the DB write, not only once at the top of `evaluate` —
 * per the task's explicit requirement that it be rechecked immediately
 * before sending.
 */
@Injectable()
export class GoldExecutionCoordinatorService {
  private readonly logger = new Logger(GoldExecutionCoordinatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeSettings: GoldRuntimeSettingsService,
  ) {}

  async evaluate(signal: GoldSignal, context: GoldCoordinatorContext): Promise<GoldCoordinatorResult> {
    const mode = getGoldExecutionMode();
    const stopNewEntriesActive = isStopNewEntriesActive();

    if (mode === 'OFF') {
      this.logger.log(`GOLD_EXECUTION_MODE=OFF — not evaluating signal for level ${signal.levelId}`);
      return { mode, stopNewEntriesActive, verdict: null, queuedDecisionId: null };
    }

    // Live entry-window recheck, immediately before submission — the touch itself was already
    // confirmed in-window using ITS OWN bar time (confirmed-retest-v2/replay.ts), but that check
    // says nothing about whether NOW (submission time) is still inside 04:00-12:00 Beirut. A
    // touch discovered near the boundary and picked up late (candle-sync/scheduler latency, or a
    // backlog after downtime) must not be submitted as a late order outside the window.
    const nowBeirutSecs = beirutSecondsOfDay(context.nowT);
    const stillInWindow = nowBeirutSecs >= SPEC.session.entryWindowStartSecondsBeirut && nowBeirutSecs < SPEC.session.entryWindowEndSecondsBeirutExclusive;
    if (!stillInWindow) {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
          entryPrice: signal.currentExecutablePrice, stopLoss: null, takeProfit: null,
          reasoning: signal.reasoning,
          inputSnapshot: { signal, context, mode } as any,
          riskManagerApproved: false,
          riskManagerRejectionReason: `Touch was in-window at its own bar time, but the current wall-clock time (${new Date(context.nowT).toISOString()}) has moved outside the 04:00-12:00 Asia/Beirut entry window — refusing to submit a late order.`,
          orderStatus: 'NONE',
        },
      });
      this.logger.warn(`level ${signal.levelId}: touch was in-window but now (${new Date(context.nowT).toISOString()}) is outside the entry window — not submitting.`);
      return { mode, stopNewEntriesActive, verdict: null, queuedDecisionId: row.id };
    }

    // Live signal-age recheck — how long since the touch bar actually closed, not how close the
    // price still is (that's the separate entryDeviationPoints check below). Rejects a touch that
    // is technically still in-window and within price tolerance but was simply discovered too
    // late to be a genuine "first touch" reaction anymore.
    const signalAgeSeconds = (context.nowT - signal.touchEndT) / 1000;
    if (signalAgeSeconds > GOLD_MAX_SIGNAL_AGE_SECONDS) {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
          entryPrice: signal.currentExecutablePrice, stopLoss: null, takeProfit: null,
          reasoning: signal.reasoning,
          inputSnapshot: { signal, context, mode, signalAgeSeconds } as any,
          riskManagerApproved: false,
          riskManagerRejectionReason: `Signal is ${signalAgeSeconds.toFixed(0)}s old (touch closed at ${new Date(signal.touchEndT).toISOString()}), beyond the max signal age of ${GOLD_MAX_SIGNAL_AGE_SECONDS}s — refusing to act on a stale touch.`,
          orderStatus: 'NONE',
        },
      });
      this.logger.warn(`level ${signal.levelId}: signal age ${signalAgeSeconds.toFixed(0)}s exceeds ${GOLD_MAX_SIGNAL_AGE_SECONDS}s — not submitting.`);
      return { mode, stopNewEntriesActive, verdict: null, queuedDecisionId: row.id };
    }

    const entryDeviationPoints =
      Math.abs(signal.currentExecutablePrice - signal.signalEntryPrice) / context.goldPointSize;

    const entryPrice = signal.currentExecutablePrice; // always price the bracket off the live executable price, never the stale signal price
    const stopLoss = signal.action === 'OPEN_BUY' ? entryPrice - GOLD_TP_SL_POINTS * context.goldPointSize : entryPrice + GOLD_TP_SL_POINTS * context.goldPointSize;
    const takeProfit = signal.action === 'OPEN_BUY' ? entryPrice + GOLD_TP_SL_POINTS * context.goldPointSize : entryPrice - GOLD_TP_SL_POINTS * context.goldPointSize;

    const candidate: GoldCandidateOrder = {
      action: signal.action,
      entryPrice,
      stopLoss,
      takeProfit,
      stopLossDistancePoints: GOLD_TP_SL_POINTS,
      takeProfitDistancePoints: GOLD_TP_SL_POINTS,
    };

    // Read exactly ONCE per evaluation — the single validated volume
    // snapshot threaded through risk calculation, the persisted decision,
    // and (via that same persisted row) the eventual broker submission.
    // Never re-read later in this method or by the collector hand-off.
    const requestedVolumeLots = this.runtimeSettings.getVolumeLots();

    const verdict = evaluateGoldRiskManager({
      candidate,
      accountInfo: context.accountInfo,
      occupancy: context.occupancy,
      volumeConstraints: context.volumeConstraints,
      killSwitchActive: isGoldKillSwitchActive(),
      entryDeviationPoints,
      maxEntryDeviationPoints: context.maxEntryDeviationPoints,
      requestedVolumeLots,
    });

    const inputSnapshot = { signal, context, mode, entryDeviationPoints, requestedVolumeLots };

    if (mode === 'SHADOW') {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId,
          symbol: GOLD_SYMBOL,
          action: signal.action,
          source: 'RULES_ONLY',
          entryPrice: candidate.entryPrice,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
          volumeLots: requestedVolumeLots,
          reasoning: signal.reasoning,
          inputSnapshot: inputSnapshot as any,
          riskManagerApproved: verdict.approved,
          riskManagerRejectionReason: verdict.rejectionReason,
          orderStatus: 'NONE', // SHADOW never queues a real order, regardless of verdict
        },
      });
      this.logger.log(`SHADOW: logged decision ${row.id} (approved=${verdict.approved}) — no order queued`);
      return { mode, stopNewEntriesActive, verdict, queuedDecisionId: null };
    }

    // mode === 'DEMO' from here on.
    if (!verdict.approved) {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
          entryPrice: candidate.entryPrice, stopLoss: candidate.stopLoss, takeProfit: candidate.takeProfit, volumeLots: requestedVolumeLots,
          reasoning: signal.reasoning, inputSnapshot: inputSnapshot as any,
          riskManagerApproved: false, riskManagerRejectionReason: verdict.rejectionReason, orderStatus: 'NONE',
        },
      });
      this.logger.warn(`DEMO mode but risk gate rejected: ${verdict.rejectionReason}`);
      return { mode, stopNewEntriesActive, verdict, queuedDecisionId: row.id };
    }

    // Recheck immediately before queuing, per task requirement — a value read at the top of this method is not trusted here.
    if (isStopNewEntriesActive()) {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
          entryPrice: candidate.entryPrice, stopLoss: candidate.stopLoss, takeProfit: candidate.takeProfit, volumeLots: requestedVolumeLots,
          reasoning: signal.reasoning, inputSnapshot: inputSnapshot as any,
          riskManagerApproved: true, riskManagerRejectionReason: 'STOP NEW ENTRIES was active at send time — not queued despite risk-gate approval.',
          orderStatus: 'NONE',
        },
      });
      this.logger.warn('Risk gate approved but STOP NEW ENTRIES is active — not queuing.');
      return { mode, stopNewEntriesActive: true, verdict, queuedDecisionId: row.id };
    }

    const row = await this.prisma.autonomousDecision.create({
      data: {
        accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
        entryPrice: candidate.entryPrice, stopLoss: candidate.stopLoss, takeProfit: candidate.takeProfit, volumeLots: requestedVolumeLots,
        reasoning: signal.reasoning, inputSnapshot: inputSnapshot as any,
        riskManagerApproved: true, riskManagerRejectionReason: null, orderStatus: 'PENDING',
      },
    });
    this.logger.log(`DEMO: queued gold order ${row.id} for collector pickup`);
    return { mode, stopNewEntriesActive, verdict, queuedDecisionId: row.id };
  }
}
