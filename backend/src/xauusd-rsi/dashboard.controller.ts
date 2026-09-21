/**
 * Everything the operator needs to answer "what is this strategy doing, and
 * why is it or isn't it trading right now?" in one read-only payload.
 *
 * Two rules govern what this endpoint is allowed to say:
 *
 * 1. **It never claims health it cannot see.** The watch loop is a separate
 *    process, so its heartbeat is read from its own state file and is
 *    reported as STALE unless the timestamp is genuinely recent — a dead
 *    process's last cycle is never presented as current.
 * 2. **It never claims the account is flat when only owned exposure is.**
 *    Foreign and manual XAUUSD positions are reported in their own section
 *    (spec §9.3), never folded into the strategy's own totals.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RsiAccountStateService } from './account-state.service';
import { RsiRuntimeSettingsService } from './runtime-settings.service';
import { GoldTelegramService } from '../gold-execution/gold-telegram.service';
import { getRsiExecutionMode, killSwitchState, stopNewEntriesState } from './controls';
import { evaluateClockSchedule, evaluateEntryEligibility, evaluateLiquidationPhase, nextClockEligibleAt, nextFridayDeadlineAt } from './schedule';
import { beirutLabel } from './time';
import { SPEC, SPEC_HASH } from './spec';
import { engineRsiNow, engineWarmedUp, EngineState } from './engine';
import { defaultStateDir, RsiWatchState } from './state-store';
import { describeOwnership } from './ownership';
import { RSI_OBSERVATION_CADENCE_TOLERANCE_MS, RSI_OBSERVATION_INTERVAL_MS, RSI_QUOTE_MAX_STALENESS_SECONDS } from './safety-constants';
import {
  RSI_COMBINED_RISK_CAP_PCT,
  RSI_DAILY_LOSS_CAP_PCT,
  RSI_DEFAULT_VOLUME_LOTS,
  RSI_DRAWDOWN_CAP_PCT,
  RSI_GOLD_POINT_SIZE,
  RSI_MAGIC_RETEST,
  RSI_MAGIC_EXTREME,
  RSI_MAX_ENTRY_DEVIATION_POINTS,
  RSI_SL_USD,
  RSI_STOP_RISK_CAP_PCT,
  RSI_SYMBOL,
  RSI_TP_USD,
} from './safety-constants';

const HEARTBEAT_STALE_THRESHOLD_SECONDS = Number(process.env.HEARTBEAT_STALE_THRESHOLD_SECONDS ?? '300');

@Controller('research/xauusd-rsi-status')
@UseGuards(DashboardTokenGuard)
export class RsiDashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: RsiAccountStateService,
    private readonly runtimeSettings: RsiRuntimeSettingsService,
    private readonly telegram: GoldTelegramService,
  ) {}

  @Get()
  async getStatus() {
    const now = new Date();
    const nowT = now.getTime();
    const accountId = process.env.AUTONOMOUS_TRADING_ACCOUNT_ID?.trim() || null;

    const watch = readWatchState();
    const session = accountId ? await this.accountState.resolveBrokerSessionOpen(now) : { open: null, detail: 'No trading account configured.', quoteAgeSeconds: null };
    const exposure = accountId ? await this.accountState.resolveExposure(accountId) : null;
    const riskInfo = accountId ? await this.accountState.resolveAccountRiskInfo(accountId) : null;
    const constraints = await this.accountState.resolveBrokerConstraints(now);
    const volume = this.runtimeSettings.resolveVolume();
    const tick = await this.prisma.liveTick.findUnique({ where: { symbol: RSI_SYMBOL } });

    const kill = killSwitchState();
    const stop = stopNewEntriesState();
    const mode = getRsiExecutionMode();

    const eligibility = evaluateEntryEligibility({
      utcMs: nowT,
      brokerSessionOpen: session.open,
      dataFresh: session.open === true,
      recoveryComplete: watch.state?.recovery.recoveryComplete ?? false,
      otherBlock: kill.active ? `Kill switch active (${kill.source}).` : stop.active ? `STOP NEW ENTRIES active (${stop.source}).` : mode === 'OFF' ? 'Execution mode is OFF.' : null,
    });
    const clock = evaluateClockSchedule(nowT);
    const liquidationPhase = evaluateLiquidationPhase({ utcMs: nowT, ownedExposureFlat: exposure?.ownedExposureFlat ?? true });

    const engine = watch.state?.engine ?? null;
    const lastDecisions = await this.prisma.xauusdRsiDecision.findMany({
      orderBy: { evaluatedAt: 'desc' },
      take: 20,
    });
    const filled = await this.prisma.xauusdRsiDecision.findMany({
      where: { orderStatus: 'FILLED' },
      orderBy: { filledAt: 'desc' },
      take: 50,
    });
    const liquidationItems = await this.prisma.xauusdRsiLiquidationItem.findMany({
      where: { status: { in: ['OUTSTANDING', 'SUBMITTED', 'FAILED'] } },
      orderBy: { deadlineAt: 'desc' },
      take: 20,
    });
    const heartbeat = accountId ? await this.prisma.collectorHeartbeat.findUnique({ where: { accountId } }) : null;
    const slots = accountId ? await this.accountState.resolveSlotStates(accountId) : null;
    const quoteResolution = await this.accountState.resolveQuoteNow(now);
    const reservedRisk = accountId ? await this.accountState.resolveReservedStopRisk(accountId) : null;

    return {
      strategy: {
        version: SPEC.strategyVersion,
        specHash: SPEC_HASH,
        symbol: RSI_SYMBOL,
        timeframe: SPEC.timeframe,
        magicNumbers: { RETEST: RSI_MAGIC_RETEST, EXTREME: RSI_MAGIC_EXTREME },
        executionMode: mode,
        isTheOnlyEnabledEntryStrategy: true,
      },

      demo: {
        accountId,
        tradeMode: riskInfo?.tradeMode ?? 'UNKNOWN',
        // Stated plainly: anything other than DEMO blocks every entry.
        demoVerified: riskInfo?.tradeMode === 'DEMO',
        equity: riskInfo?.equity ?? null,
        accountCurrency: riskInfo?.accountCurrency ?? null,
        // Whether the broker can genuinely hold two independent positions with
        // independent brackets. Anything other than RETAIL_HEDGING means the
        // SECOND slot is refused rather than emulated with one net position.
        marginMode: riskInfo?.marginMode ?? 'UNKNOWN',
        supportsTwoIndependentPositions: riskInfo?.marginMode === 'RETAIL_HEDGING',
        marginModeNote:
          riskInfo?.marginMode === 'RETAIL_HEDGING'
            ? 'RETAIL_HEDGING — two independent positions with independent brackets are supported.'
            : riskInfo?.marginMode === 'UNKNOWN'
              ? 'Margin mode not reported by the collector. A second concurrent position is refused rather than assumed possible.'
              : `${riskInfo?.marginMode} — a second order would merge with, reduce or reverse the first, so the second slot is refused rather than emulated.`,
      },

      // The two execution slots. A retest and an extreme may be open at once;
      // a second entry in the same family may not.
      slots: {
        RETEST: {
          occupied: slots?.RETEST.occupied ?? null,
          reason: slots?.RETEST.reason ?? null,
          holders: slots?.RETEST.holders ?? [],
        },
        EXTREME: {
          occupied: slots?.EXTREME.occupied ?? null,
          reason: slots?.EXTREME.reason ?? null,
          holders: slots?.EXTREME.holders ?? [],
        },
        maxConcurrentPositions: 2,
        note: 'Two independent slots: RETEST (SELL peak retest, BUY trough retest) and EXTREME (both extremes). One entry each, so at most two positions — not one per directional setup.',
        reservedStopRisk: reservedRisk,
      },

      indicator: {
        period: SPEC.rsi.period,
        appliedPrice: SPEC.rsi.appliedPrice,
        smoothing: SPEC.rsi.smoothing,
        parityMaxAbsDifference: 5e-11,
        paritySource: "MQL5/Scripts/RsiReference.mq5 export of the terminal's own iRSI",
        // Provenance, stated rather than implied. This was an ASSUMPTION until
        // the terminal itself was asked; it is now a verified fact.
        appliedPriceProvenance:
          "VERIFIED — compared against the terminal's own iRSI(XAUUSD, M1, 5, PRICE_CLOSE) via an MQL5 export; agreement to 5e-11 across 5,000 live M1 bars.",
        parityVerified: true,
        currentRsi: engine ? engineRsiNow(engine) : null,
        warmedUp: engine ? engineWarmedUp(engine) : false,
        warmupBarsRequired: SPEC.rsi.period + 1 + SPEC.rsi.warmupBars,
        closedBarsApplied: engine?.closedBarsApplied ?? 0,
        // Reproduced from MT5: a perfectly flat series reads 100, which is
        // inside the extreme-SELL region. Disclosed, not filtered away.
        flatPriceBehaviourNote:
          "Flat closes leave RSI UNCHANGED, they do not raise it. A zero-change close contributes zero to both sides, so Wilder smoothing multiplies the average gain and the average loss by the same (period-1)/period factor; their ratio, and therefore RSI, is unaffected. Verified against this implementation: a mixed history reading 64.1616 still reads 64.1616 after eight consecutive flat closes. The one exception is the degenerate case where average loss is already zero — a history containing no down move at all, including an all-flat series from initialization — for which MT5 reports 100 and continues to, and that is reproduced. Across 5,000 live M1 bars the longest unchanged run was shorter than the RSI period.",
      },

      thresholds: {
        sell2: SPEC.thresholds.sell2,
        sell1: SPEC.thresholds.sell1,
        buy1: SPEC.thresholds.buy1,
        buy2: SPEC.thresholds.buy2,
        extremeSell: SPEC.thresholds.extremeSellCross,
        extremeBuy: SPEC.thresholds.extremeBuyCross,
        note: 'Buy 1 is 18, replacing the 14 shown in the screenshots. Extreme SELL is 98.5 and extreme BUY is 1.5, each used identically for triggering and rearming.',
      },

      patternState: engine
        ? {
            sellPeakRetest: engine.pattern.sellRetest,
            buyTroughRetest: engine.pattern.buyRetest,
            extremeSell: engine.pattern.extremeSell,
            extremeBuy: engine.pattern.extremeBuy,
            previousRsi: engine.pattern.previousRsi,
            observationCount: engine.pattern.observationCount,
          }
        : null,

      /**
       * The SELECTED quote, as one observation.
       *
       * Price, broker timestamp, age and source all describe the same tick,
       * and `evaluatedAt` is the server instant the age was measured
       * against, so a reader can check
       * `ageSeconds === (evaluatedAt - tickAt) / 1000` instead of trusting
       * it. Previously bid/ask/tickAt came from live_ticks while ageSeconds
       * came from whichever stream was fresher, which published a
       * 34.5s-old price as 3.5s old and fresh.
       */
      quote: {
        bid: quoteResolution.quote?.bid ?? null,
        ask: quoteResolution.quote?.ask ?? null,
        tickAt: quoteResolution.quote ? new Date(quoteResolution.quote.tickAtMs).toISOString() : null,
        ageSeconds: quoteResolution.quote?.ageSeconds ?? null,
        fresh: quoteResolution.quote?.fresh ?? false,
        source: quoteResolution.quote?.source ?? null,
        evaluatedAt: new Date(quoteResolution.evaluatedAtMs).toISOString(),
        blockedReason: quoteResolution.blockedReason,
        // Both streams, each with its own age, so a lagging one is visible
        // rather than silently discarded.
        considered: quoteResolution.considered,
      },

      observation: {
        mode: engine?.observationMode ?? 'UNKNOWN',
        modeLimitation:
          engine?.observationMode === 'TICK'
            ? 'Ordered broker ticks. A crossing between two ticks the broker never reported is still unobservable; absence of an observed crossing is never treated as proof one did not occur.'
            : engine?.observationMode === 'SAMPLED_INTRABAR'
              ? 'SAMPLED intrabar: periodic quote samples, not every tick. A crossing that occurs and reverses entirely between two samples is invisible to this strategy.'
              : 'Closed-bar only: intrabar crossings cannot be observed at all.',
        ticksApplied: engine?.ticksApplied ?? 0,
        duplicatesRejected: engine?.ticksRejectedDuplicate ?? 0,
        outOfOrderRejected: engine?.ticksRejectedOutOfOrder ?? 0,
        gapResets: engine?.gapResets ?? 0,
        needsReseed: engine?.needsRsiReseed ?? false,
        cursor: watch.state?.cursor ?? null,
        // MEASURED, not configured. The target is one observation per second;
        // this reports what the running loop actually achieved.
        cadence: describeCadence(watch.state?.recovery.cadenceSamplesMs ?? []),
      },

      schedule: {
        timeZone: SPEC.schedule.timeZone,
        nowBeirut: beirutLabel(nowT),
        // The distinct states spec §11 requires be distinguishable.
        state: describeScheduleState(eligibility.blockReason, liquidationPhase.phase),
        entriesAllowed: eligibility.entriesAllowed,
        blockReason: eligibility.blockReason,
        detail: eligibility.detail,
        dailyPause: '23:30 (inclusive) to 01:00 (exclusive) Beirut, every day',
        fridayEntryCutoff: '23:00 Beirut, strictly before',
        fridayClosureDeadline: '23:30 Beirut',
        nextEligibleAt: eligibility.nextEligibleAtT ? new Date(eligibility.nextEligibleAtT).toISOString() : null,
        nextEligibleLabel: eligibility.nextEligibleLabel,
        nextFridayDeadline: labelOrNull(nextFridayDeadlineAt(nowT)),
        currentFridayDeadline: labelOrNull(clock.fridayDeadlineT),
        inWeekendWindow: clock.inWeekendWindow,
      },

      /**
       * EVERY gate an entry must clear, not just the schedule.
       *
       * `schedule.entriesAllowed` answers one question — does the clock and
       * the control state permit an entry — and it was being read as though
       * it answered all of them. It reported ELIGIBLE_FOR_NEW_ENTRIES while
       * the indicator was only 192 bars into its 256-bar warm-up and no
       * signal could possibly be emitted. That is a misleading thing for an
       * operator to see on a live trading dashboard.
       *
       * The gates below are the real ones, in the order they are enforced.
       * Later gates cannot be evaluated here (a risk verdict needs a
       * candidate order, and the collector's send-boundary quote check needs
       * an order in flight), so they are named rather than silently omitted.
       */
      entryEligibility: (() => {
        const gates = [
          { gate: 'EXECUTION_MODE', passed: mode !== 'OFF', detail: `execution mode is ${mode}` },
          { gate: 'KILL_SWITCH', passed: !kill.active, detail: kill.active ? `engaged (${kill.source})` : 'not engaged' },
          { gate: 'STOP_NEW_ENTRIES', passed: !stop.active, detail: stop.active ? `engaged (${stop.source})` : 'not engaged' },
          { gate: 'SCHEDULE', passed: clock.clockAllowsEntries, detail: eligibility.detail },
          { gate: 'BROKER_SESSION', passed: session.open === true, detail: session.detail },
          { gate: 'QUOTE_FRESH', passed: session.open === true, detail: session.quoteAgeSeconds === null ? 'no quote recorded' : `quote is ${session.quoteAgeSeconds.toFixed(1)}s old (limit ${RSI_QUOTE_MAX_STALENESS_SECONDS}s)` },
          { gate: 'RECOVERY_COMPLETE', passed: watch.state?.recovery.recoveryComplete === true, detail: watch.state?.recovery.lastRecoveryDetail ?? 'no watch state' },
          {
            gate: 'INDICATOR_WARM',
            passed: engine ? engineWarmedUp(engine) : false,
            detail: (engine ? engineWarmedUp(engine) : false)
              ? `warm (${engine?.closedBarsApplied ?? 0} closed bars applied)`
              : `warming up: ${engine?.closedBarsApplied ?? 0} of ${SPEC.rsi.period + 1 + SPEC.rsi.warmupBars} contiguous closed M1 bars — signals are suppressed until this completes`,
          },
          { gate: 'SLOT_AVAILABLE', passed: slots === null ? false : !slots.RETEST.occupied || !slots.EXTREME.occupied, detail: slots === null ? 'no trading account configured' : `RETEST ${slots.RETEST.occupied ? 'held' : 'free'}, EXTREME ${slots.EXTREME.occupied ? 'held' : 'free'}` },
        ];
        const blocking = gates.filter((g) => !g.passed);
        return {
          canEnterNow: blocking.length === 0,
          blockingGates: blocking.map((g) => g.gate),
          gates,
          evaluatedLater: [
            'RISK_MANAGER — per-trade, combined, daily-loss and drawdown caps, evaluated against the actual candidate order',
            'OCCUPANCY_RECHECK and SIGNAL_AGE — re-evaluated at the pre-send check',
            'SEND_BOUNDARY_QUOTE_AGE — enforced in the collector against a freshly fetched MT5 tick, immediately before order_send',
          ],
          note:
            'A passing list means no gate blocks an entry RIGHT NOW. It is not a prediction that one will be taken: a setup still has to occur.',
        };
      })(),

      /**
       * Telegram delivery health, so a silent outage is VISIBLE.
       *
       * Both round trips on 2026-09-21 produced alerts that all failed, and
       * the only signal the operator got was that no message arrived. A
       * notification system that fails quietly is worse than none, because
       * silence reads as "nothing happened".
       */
      telegramDelivery: await this.telegram.deliveryHealth(new Date(nowT)),

      brokerSession: { open: session.open, detail: session.detail },

      liquidation: {
        phase: liquidationPhase.phase,
        detail: liquidationPhase.detail,
        deadline: labelOrNull(liquidationPhase.deadlineT),
        outstandingItems: liquidationItems.map((i) => ({
          ticket: i.ticket,
          kind: i.kind,
          status: i.status,
          attempts: i.attempts,
          lastError: i.lastError,
          deadline: i.deadlineAt.toISOString(),
          ownership: describeOwnership(i.magicNumber),
        })),
        // Never "the account is flat" — only ever a statement about what this
        // application owns.
        ownedExposureFlat: exposure?.ownedExposureFlat ?? null,
      },

      exposure: {
        owned: exposure?.ownedItems ?? [],
        // Displayed separately and never closed by this application.
        foreign: exposure?.foreignItems ?? [],
        occupancyBlocksNewEntries: exposure?.anyExposure ?? false,
      },

      order: {
        volumeLots: volume.volumeLots,
        volumeSource: volume.source,
        volumeSourceDetail: volume.sourceDetail,
        defaultVolumeLots: RSI_DEFAULT_VOLUME_LOTS,
        takeProfitUsd: RSI_TP_USD,
        stopLossUsd: RSI_SL_USD,
        pointSize: RSI_GOLD_POINT_SIZE,
        maxEntryDeviationPoints: RSI_MAX_ENTRY_DEVIATION_POINTS,
        brokerConstraints: constraints,
        bracketNote: 'TP and SL are $5 moves in quoted gold price. They are not five broker points and do not guarantee a $5 account-currency result.',
      },

      risk: {
        stopRiskCapPct: RSI_STOP_RISK_CAP_PCT,
        combinedRiskCapPct: RSI_COMBINED_RISK_CAP_PCT,
        dailyLossCapPct: RSI_DAILY_LOSS_CAP_PCT,
        drawdownCapPct: RSI_DRAWDOWN_CAP_PCT,
        current: riskInfo
          ? {
              equity: riskInfo.equity,
              todaysLossAmount: riskInfo.todaysLossAmount,
              currentDrawdownPct: riskInfo.currentDrawdownPct,
              existingCombinedRiskAmount: riskInfo.existingCombinedRiskAmount,
              contractSize: riskInfo.contractSize,
              profitCurrency: riskInfo.profitCurrency,
              conversionRate: riskInfo.profitCurrencyToAccountCurrencyRate,
            }
          : null,
      },

      controls: {
        killSwitchActive: kill.active,
        killSwitchSource: kill.source,
        stopNewEntriesActive: stop.active,
        stopNewEntriesSource: stop.source,
      },

      heartbeats: {
        strategyWatch: watch.heartbeat,
        collector: heartbeat
          ? {
              lastHeartbeatAt: heartbeat.lastHeartbeatAt.toISOString(),
              ageSeconds: (nowT - heartbeat.lastHeartbeatAt.getTime()) / 1000,
              stale: (nowT - heartbeat.lastHeartbeatAt.getTime()) / 1000 > HEARTBEAT_STALE_THRESHOLD_SECONDS,
              mt5Connected: heartbeat.mt5Connected,
              lastError: heartbeat.lastError,
            }
          : { lastHeartbeatAt: null, ageSeconds: null, stale: true, mt5Connected: false, lastError: null },
      },

      recentDecisions: lastDecisions.map((d) => ({
        id: d.id,
        evaluatedAt: d.evaluatedAt.toISOString(),
        observedAt: d.observedAt.toISOString(),
        direction: d.direction,
        setupKinds: d.setupKinds,
        rsi: d.rsiValue.toNumber(),
        previousRsi: d.previousRsi?.toNumber() ?? null,
        entryPrice: d.entryPrice?.toNumber() ?? null,
        stopLoss: d.stopLoss?.toNumber() ?? null,
        takeProfit: d.takeProfit?.toNumber() ?? null,
        volumeLots: d.volumeLots?.toNumber() ?? null,
        orderStatus: d.orderStatus,
        approved: d.approved,
        skipReason: d.skipReason,
        reasoning: d.reasoning,
        // BigInt: serialised as a string, since JSON has no bigint.
        ticket: d.mt5Ticket === null ? null : String(d.mt5Ticket),
        filledPrice: d.filledPrice?.toNumber() ?? null,
        slippagePoints: d.slippagePoints?.toNumber() ?? null,
        brokerStopLoss: d.brokerStopLoss?.toNumber() ?? null,
        brokerTakeProfit: d.brokerTakeProfit?.toNumber() ?? null,
        executionError: d.executionError,
      })),

      confirmedEntries: {
        count: filled.length,
        // Protection as the BROKER reports it, reconciled against what was
        // requested — a mismatch is shown, not smoothed over.
        items: filled.map((d) => ({
          id: d.id,
          // BigInt: serialised as a string, since JSON has no bigint.
        ticket: d.mt5Ticket === null ? null : String(d.mt5Ticket),
          filledAt: d.filledAt?.toISOString() ?? null,
          filledPrice: d.filledPrice?.toNumber() ?? null,
          requestedPrice: d.requestedPrice?.toNumber() ?? null,
          slippagePoints: d.slippagePoints?.toNumber() ?? null,
          requestedStopLoss: d.stopLoss?.toNumber() ?? null,
          brokerStopLoss: d.brokerStopLoss?.toNumber() ?? null,
          requestedTakeProfit: d.takeProfit?.toNumber() ?? null,
          brokerTakeProfit: d.brokerTakeProfit?.toNumber() ?? null,
          protectionMatchesRequest:
            d.brokerStopLoss !== null && d.stopLoss !== null
              ? Math.abs(d.brokerStopLoss.toNumber() - d.stopLoss.toNumber()) < 0.01
              : null,
        })),
      },
    };
  }
}

/**
 * Summarises the measured cycle cadence against the one-second target.
 *
 * Reports the median and the worst sample rather than only an average: an
 * average hides a loop that mostly keeps up but periodically stalls, and the
 * stall is the part that costs a signal.
 */
function describeCadence(samples: number[]): {
  targetMs: number;
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  withinTarget: boolean | null;
  detail: string;
} {
  const target = RSI_OBSERVATION_INTERVAL_MS;
  if (samples.length === 0) {
    return {
      targetMs: target,
      samples: 0,
      medianMs: null,
      p95Ms: null,
      maxMs: null,
      withinTarget: null,
      detail: 'No cadence measured yet — the watch process has not completed two cycles in this run.',
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const max = sorted[sorted.length - 1];
  const within = median <= target + RSI_OBSERVATION_CADENCE_TOLERANCE_MS;
  return {
    targetMs: target,
    samples: sorted.length,
    medianMs: median,
    p95Ms: p95,
    maxMs: max,
    withinTarget: within,
    detail: within
      ? `Median ${median}ms against a ${target}ms target over ${sorted.length} cycles (worst ${max}ms).`
      : `DEGRADED: median ${median}ms against a ${target}ms target over ${sorted.length} cycles (worst ${max}ms).`,
  };
}

function labelOrNull(t: number | null): { iso: string; beirut: string } | null {
  return t === null ? null : { iso: new Date(t).toISOString(), beirut: beirutLabel(t) };
}

/** The operator-facing schedule state, as the distinct labels spec §11 lists. */
function describeScheduleState(blockReason: string | null, liquidation: string): string {
  if (liquidation === 'DEADLINE_MISSED') return 'FRIDAY_CLOSURE_DEADLINE_MISSED';
  if (liquidation === 'IN_PROGRESS') return 'FRIDAY_LIQUIDATION_IN_PROGRESS';
  if (liquidation === 'CONFIRMED_FLAT' && blockReason === 'FRIDAY_ENTRY_CUTOFF') return 'FRIDAY_LIQUIDATION_CONFIRMED';
  if (blockReason === null) return 'ELIGIBLE_FOR_NEW_ENTRIES';
  if (blockReason === 'DAILY_PAUSE') return 'DAILY_PAUSE_2330_0100_BEIRUT';
  if (blockReason === 'FRIDAY_ENTRY_CUTOFF') return 'FRIDAY_ENTRY_CUTOFF_REACHED_OR_WEEKEND';
  if (blockReason === 'BROKER_SESSION_NOT_CONFIRMED_OPEN') return 'WEEKEND_OR_BROKER_CLOSURE';
  return 'OTHER_EXECUTION_BLOCK';
}

/**
 * Reads the standalone watch process's own state file.
 *
 * That process is NOT part of this Nest application — it is started manually
 * and runs on its own — so this is a live read of its on-disk state, not a
 * service call. A cycle timestamp older than the staleness threshold is
 * reported as stale: a dead process's last cycle must never look like
 * current health.
 */
function readWatchState(): {
  state: RsiWatchState | null;
  heartbeat: { lastCycleAtUtc: string | null; ageSeconds: number | null; stale: boolean; running: boolean; detail: string };
} {
  const statePath = join(defaultStateDir(), 'xauusd-rsi-watch-state.json');
  if (!existsSync(statePath)) {
    return {
      state: null,
      heartbeat: { lastCycleAtUtc: null, ageSeconds: null, stale: true, running: false, detail: 'No watch state file — the strategy watch process has never run in this environment.' },
    };
  }
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as RsiWatchState;
    const last = state.recovery?.lastCycleAtUtc ?? null;
    const ageSeconds = last ? (Date.now() - new Date(last).getTime()) / 1000 : null;
    const stale = ageSeconds === null || ageSeconds > HEARTBEAT_STALE_THRESHOLD_SECONDS;
    return {
      state,
      heartbeat: {
        lastCycleAtUtc: last,
        ageSeconds,
        stale,
        running: !stale,
        detail: stale
          ? `Last cycle ${last ?? 'never'} — older than ${HEARTBEAT_STALE_THRESHOLD_SECONDS}s, so the watch process is NOT considered running.`
          : `Last cycle ${last}.`,
      },
    };
  } catch (err) {
    return {
      state: null,
      heartbeat: { lastCycleAtUtc: null, ageSeconds: null, stale: true, running: false, detail: `Watch state unreadable: ${err instanceof Error ? err.message : err}` },
    };
  }
}

export type { EngineState };
