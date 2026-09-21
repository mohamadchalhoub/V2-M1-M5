/**
 * Turns an engine signal into either a queued order or a recorded skip.
 *
 * Every outcome writes a row. A signal blocked by the schedule, by
 * occupancy, by risk or by a control is recorded with `orderStatus: NONE`
 * and a `skipReason`, because spec §12 requires skipped events be reportable
 * with their reasons, and spec §9.5 requires a blocked signal be consumed
 * rather than queued for later. Nothing is ever deferred to a queue that
 * might drain after the block lifts.
 *
 * Has no scheduler of its own by design — something else must call
 * `evaluate()` with a real signal. It is never invoked speculatively.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmittedSignal } from './engine';
import { entriesBlockedByControls, getRsiExecutionMode, isRsiKillSwitchActive, stopNewEntriesState } from './controls';
import { RsiRuntimeSettingsService } from './runtime-settings.service';
import { RsiAccountStateService } from './account-state.service';
import { buildRsiBracket, evaluateRsiRiskManager } from './risk-manager';
import { evaluateEntryEligibility } from './schedule';
import { SPEC, SPEC_HASH } from './spec';
import { Prisma } from '@prisma/client';
import {
  RSI_GOLD_POINT_SIZE,
  rsiMagicForFamily,
  RSI_MAX_ENTRY_DEVIATION_POINTS,
  RSI_MAX_SIGNAL_AGE_SECONDS,
  RSI_SL_POINTS,
  RSI_SL_USD,
  RSI_SYMBOL,
  RSI_TP_POINTS,
  RSI_TP_USD,
} from './safety-constants';

export interface RsiCoordinatorContext {
  accountId: string;
  /** Wall-clock now. Every time-dependent recheck uses THIS, never the signal's own time. */
  nowT: number;
  /** Freshest executable price for the signal's direction: ask for BUY, bid for SELL. */
  currentExecutablePrice: number;
  brokerSessionOpen: boolean | null;
  brokerSessionDetail: string;
  dataFresh: boolean;
  recoveryComplete: boolean;
}

export interface RsiCoordinatorResult {
  mode: 'OFF' | 'SHADOW' | 'DEMO';
  decisionId: string;
  queued: boolean;
  skipReason: string | null;
}

@Injectable()
export class RsiCoordinatorService {
  private readonly logger = new Logger(RsiCoordinatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeSettings: RsiRuntimeSettingsService,
    private readonly accountState: RsiAccountStateService,
  ) {}

  async evaluate(signal: EmittedSignal, context: RsiCoordinatorContext): Promise<RsiCoordinatorResult> {
    const mode = getRsiExecutionMode();
    const action = signal.direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL';
    const family = signal.family;
    // Stable identity of this observation-plus-family. A replayed or retried
    // evaluation of the same event is recognisable as the same event rather
    // than becoming a second decision.
    const eventId = `${SPEC_HASH}:${family}:${signal.atT}:${[...signal.kinds].sort().join('+')}`;

    const record = async (params: {
      approved: boolean;
      skipReason: string | null;
      queued: boolean;
      entryPrice: number | null;
      stopLoss: number | null;
      takeProfit: number | null;
      volumeLots: number | null;
      extraEvidence: Record<string, unknown>;
    }) => {
      const row = await this.prisma.xauusdRsiDecision.create({
        data: {
          strategyVersion: SPEC.strategyVersion,
          specHash: SPEC_HASH,
          accountId: context.accountId,
          symbol: RSI_SYMBOL,
          observedAt: new Date(signal.atT),
          direction: signal.direction,
          ruleFamily: family,
          eventId,
          setupKinds: signal.kinds,
          rsiValue: signal.rsi,
          previousRsi: signal.evidence.previousRsi,
          basisPrice: signal.basisPrice,
          observationMode: signal.evidence.observationMode,
          entryPrice: params.entryPrice,
          stopLoss: params.stopLoss,
          takeProfit: params.takeProfit,
          volumeLots: params.volumeLots,
          requestedPrice: params.entryPrice,
          reasoning: signal.reason,
          evidence: {
            signal: signal.evidence,
            mode,
            context: {
              nowT: context.nowT,
              nowIso: new Date(context.nowT).toISOString(),
              currentExecutablePrice: context.currentExecutablePrice,
              brokerSessionOpen: context.brokerSessionOpen,
              brokerSessionDetail: context.brokerSessionDetail,
              dataFresh: context.dataFresh,
              recoveryComplete: context.recoveryComplete,
            },
            ...params.extraEvidence,
          } as object,
          approved: params.approved,
          skipReason: params.skipReason,
          orderStatus: params.queued ? 'PENDING' : 'NONE',
          magicNumber: rsiMagicForFamily(family),
          // A row that never became an order never holds a slot. Setting the
          // release timestamp at creation keeps it out of the partial unique
          // index entirely, so a long history of skipped signals can never
          // block a family.
          slotReleasedAt: params.queued ? null : new Date(),
        },
      });
      return row.id;
    };

    if (mode === 'OFF') {
      const id = await record({
        approved: false,
        skipReason: 'Execution mode is OFF — the signal was observed and consumed, but no order was evaluated or queued.',
        queued: false,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        volumeLots: null,
        extraEvidence: {},
      });
      this.logger.log(`mode=OFF — recorded signal ${id} without evaluating`);
      return { mode, decisionId: id, queued: false, skipReason: 'Execution mode is OFF.' };
    }

    // --- Schedule, rechecked at evaluation time against wall clock. ---
    const eligibility = evaluateEntryEligibility({
      utcMs: context.nowT,
      brokerSessionOpen: context.brokerSessionOpen,
      dataFresh: context.dataFresh,
      recoveryComplete: context.recoveryComplete,
      otherBlock: null,
    });
    if (!eligibility.entriesAllowed) {
      const reason = `${eligibility.blockReason}: ${eligibility.detail}`;
      const id = await record({
        approved: false,
        skipReason: reason,
        queued: false,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        volumeLots: null,
        extraEvidence: { eligibility },
      });
      this.logger.log(`signal skipped (${eligibility.blockReason}) — decision ${id}`);
      return { mode, decisionId: id, queued: false, skipReason: reason };
    }

    // --- Signal age, measured from the observation itself. ---
    const signalAgeSeconds = (context.nowT - signal.atT) / 1000;
    if (signalAgeSeconds > RSI_MAX_SIGNAL_AGE_SECONDS) {
      const reason = `Signal is ${signalAgeSeconds.toFixed(1)}s old (limit ${RSI_MAX_SIGNAL_AGE_SECONDS}s) — refusing to act on a stale intrabar event.`;
      const id = await record({
        approved: false,
        skipReason: reason,
        queued: false,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        volumeLots: null,
        extraEvidence: { signalAgeSeconds },
      });
      return { mode, decisionId: id, queued: false, skipReason: reason };
    }

    // --- Bracket, priced off the LIVE executable price, never the signal's basis. ---
    const entryPrice = context.currentExecutablePrice;
    const { stopLoss, takeProfit } = buildRsiBracket(action, entryPrice, RSI_TP_USD, RSI_SL_USD);
    const entryDeviationPoints = Math.abs(entryPrice - signal.basisPrice) / RSI_GOLD_POINT_SIZE;

    // Read exactly once, then threaded through risk, the persisted row, and
    // the eventual broker submission — never re-read at a later point where
    // it could have changed.
    const resolvedVolume = this.runtimeSettings.resolveVolume();

    const [baseAccountInfo, occupancy, constraints, reservedRisk] = await Promise.all([
      this.accountState.resolveAccountRiskInfo(context.accountId),
      this.accountState.resolveOccupancy(context.accountId, family),
      this.accountState.resolveBrokerConstraints(new Date(context.nowT)),
      // Stop risk already committed by slot-holding decisions. Because a slot
      // is reserved by INSERTING the decision, a first entry evaluated moments
      // earlier in this same observation is ALREADY counted here — which is
      // exactly what stops two simultaneous family signals from jointly
      // exceeding the combined cap.
      this.accountState.resolveReservedStopRisk(context.accountId),
    ]);
    // Whether the OTHER family is holding, which determines if accepting this
    // candidate would mean two concurrent positions on one symbol.
    const slots = await this.accountState.resolveSlotStates(context.accountId);
    const otherFamilySlotHeld = family === 'RETEST' ? slots.EXTREME.occupied : slots.RETEST.occupied;
    const accountInfo = {
      ...baseAccountInfo,
      existingCombinedRiskAmount: baseAccountInfo.existingCombinedRiskAmount + reservedRisk.amount,
    };

    const verdict = evaluateRsiRiskManager({
      candidate: {
        action,
        entryPrice,
        stopLoss,
        takeProfit,
        stopLossDistancePoints: Math.abs(entryPrice - stopLoss) / RSI_GOLD_POINT_SIZE,
        takeProfitDistancePoints: Math.abs(entryPrice - takeProfit) / RSI_GOLD_POINT_SIZE,
      },
      accountInfo,
      occupancy,
      constraints,
      killSwitchActive: isRsiKillSwitchActive(),
      entriesBlockedReason: entriesBlockedByControls(),
      entryDeviationPoints,
      maxEntryDeviationPoints: RSI_MAX_ENTRY_DEVIATION_POINTS,
      requestedVolumeLots: resolvedVolume.volumeLots,
      pointSize: RSI_GOLD_POINT_SIZE,
      otherFamilySlotHeld,
    });

    const riskEvidence = {
      family,
      eventId,
      eligibility,
      reservedStopRisk: reservedRisk,
      otherFamilySlotHeld,
      slots: { RETEST: slots.RETEST.occupied, EXTREME: slots.EXTREME.occupied },
      entryDeviationPoints,
      requestedVolume: resolvedVolume,
      accountInfo,
      occupancy,
      constraints,
      verdict,
      expectedBracketPoints: { stopLoss: RSI_SL_POINTS, takeProfit: RSI_TP_POINTS },
    };

    if (mode === 'SHADOW') {
      const id = await record({
        approved: verdict.approved,
        skipReason: verdict.approved
          ? 'SHADOW mode — the decision was fully evaluated and approved, but SHADOW never queues a real order.'
          : verdict.rejectionReason,
        queued: false,
        entryPrice,
        stopLoss,
        takeProfit,
        volumeLots: verdict.volumeLots,
        extraEvidence: riskEvidence,
      });
      this.logger.log(`SHADOW: recorded decision ${id} (approved=${verdict.approved})`);
      return { mode, decisionId: id, queued: false, skipReason: 'SHADOW mode — no order queued.' };
    }

    // --- DEMO from here. ---
    if (!verdict.approved) {
      const id = await record({
        approved: false,
        skipReason: verdict.rejectionReason,
        queued: false,
        entryPrice,
        stopLoss,
        takeProfit,
        volumeLots: null,
        extraEvidence: riskEvidence,
      });
      this.logger.warn(`risk gate rejected: ${verdict.rejectionReason}`);
      return { mode, decisionId: id, queued: false, skipReason: verdict.rejectionReason };
    }

    // Re-read immediately before the write — a value read at the top of this
    // method is not trusted at the point of queuing.
    const stopNow = stopNewEntriesState();
    if (stopNow.active) {
      const reason = `STOP NEW ENTRIES became active before queuing (${stopNow.source}) — approved by risk, but not queued.`;
      const id = await record({
        approved: true,
        skipReason: reason,
        queued: false,
        entryPrice,
        stopLoss,
        takeProfit,
        volumeLots: verdict.volumeLots,
        extraEvidence: riskEvidence,
      });
      return { mode, decisionId: id, queued: false, skipReason: reason };
    }

    // The INSERT itself is the slot reservation. A partial unique index
    // permits only one slot-holding decision per account per family, so two
    // concurrent evaluations cannot both succeed here — the loser is rejected
    // by the database rather than by a check that could interleave with it.
    try {
      const id = await record({
        approved: true,
        skipReason: null,
        queued: true,
        entryPrice,
        stopLoss,
        takeProfit,
        volumeLots: verdict.volumeLots,
        extraEvidence: riskEvidence,
      });
      this.logger.log(
        `DEMO: reserved the ${family} slot and queued order ${id} (${action} @ ${entryPrice}, SL ${stopLoss}, TP ${takeProfit}, ${verdict.volumeLots} lots)`,
      );
      return { mode, decisionId: id, queued: true, skipReason: null };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const reason =
          `The ${family} slot was taken by a concurrent submission between this evaluation's occupancy check and its write. ` +
          'Refusing rather than opening a second position for the same family.';
        const id = await record({
          approved: true,
          skipReason: reason,
          queued: false,
          entryPrice,
          stopLoss,
          takeProfit,
          volumeLots: verdict.volumeLots,
          extraEvidence: { ...riskEvidence, slotReservationLost: true },
        });
        this.logger.warn(`${family} slot reservation lost to a concurrent submission — decision ${id} not queued`);
        return { mode, decisionId: id, queued: false, skipReason: reason };
      }
      throw err;
    }
  }
}
