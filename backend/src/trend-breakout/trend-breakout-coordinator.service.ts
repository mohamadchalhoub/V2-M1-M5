import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutonomousOrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HistoricalCandleService } from '../market-data/historical-candle.service';
import { TREND_BREAKOUT_STRATEGY_VERSION } from '../strategy-versions';
import { resolveConversionRate } from './currency-conversion';
import { checkGapChaseFilter, isSignalExpired, selectExecutablePrice } from './entry-timing';
import { GateResult, failGate, passGate } from './gate-result';
import { InstrumentMapping, resolveInstrumentMappings, TREND_BREAKOUT_INSTRUMENTS, TrendBreakoutInstrumentId } from './instrument-config';
import {
  evaluateCombinedRiskGate,
  evaluateDailyLossGate,
  evaluateDrawdownGate,
  evaluateQuoteAgeGate,
  evaluateSpreadGate,
  evaluateTradeRiskGate,
  estimateStopRiskAmount,
} from './risk-policy';
import { TrendBreakoutRiskPolicySettingsService } from './risk-policy-settings.service';
import { TrendBreakoutRiskStateService } from './risk-state.service';
import { getBeirutWallClock, isWithinEntryWindow } from './schedule';
import { evaluateTrendBreakoutSignal } from './signal-engine';
import { computeRoundedSlTp, isSlTpError } from './sl-tp';
import { TrendBreakoutSlotLockService } from './slot-lock.service';
import { SymbolMetadataService } from './symbol-metadata.service';
import { TrendBreakoutDecisionLoggerService } from './trend-breakout-decision-logger.service';
import { TrendBreakoutVolumeSettingsService } from './volume-settings.service';
import { getTrendBreakoutExecutionMode, isStopNewEntriesActive } from './trend-breakout-execution-mode';
import { isTrendBreakoutKillSwitchActive } from './trend-breakout-kill-switch';

export interface InstrumentEvaluationOutcome {
  instrument: TrendBreakoutInstrumentId;
  action: 'OPEN_BUY' | 'OPEN_SELL' | 'HOLD';
  decisionId: string;
  rejectionReason: string | null;
}

/**
 * §6-§10 orchestration — fetches real H4/H1 candles + a live quote + real
 * account state for ONE instrument, calls the pure `evaluateTrendBreakoutSignal`,
 * then runs every entry-timing/risk gate in order, logging a full
 * `TrendBreakoutDecision` row (HOLD included, per §8/§12) either way. On an
 * approved entry it claims the instrument's slot lock and the decision
 * atomically (same transaction) and marks it `orderStatus = PENDING` for a
 * collector poll to pick up — mirroring `AutonomousExecutionCoordinatorService`'s
 * own PENDING-order handoff pattern.
 *
 * Deliberately has NO scheduler of its own — nothing calls `evaluateAll()`
 * on a timer. Same explicit, separate decision as the legacy coordinator:
 * this code exists and is tested, but does not run unsupervised until a
 * human wires up a scheduler as its own deliberate step (see the delivery
 * report's "remaining prerequisites").
 */
@Injectable()
export class TrendBreakoutCoordinatorService {
  private readonly logger = new Logger(TrendBreakoutCoordinatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candles: HistoricalCandleService,
    private readonly volumeSettings: TrendBreakoutVolumeSettingsService,
    private readonly symbolMetadata: SymbolMetadataService,
    private readonly slotLock: TrendBreakoutSlotLockService,
    private readonly riskState: TrendBreakoutRiskStateService,
    private readonly riskPolicySettings: TrendBreakoutRiskPolicySettingsService,
    private readonly decisionLogger: TrendBreakoutDecisionLoggerService,
    private readonly config: ConfigService,
  ) {}

  async evaluateAll(accountId: string, now: Date): Promise<InstrumentEvaluationOutcome[]> {
    const mappings = resolveInstrumentMappings(this.config);
    const outcomes: InstrumentEvaluationOutcome[] = [];
    for (const instrument of TREND_BREAKOUT_INSTRUMENTS) {
      outcomes.push(await this.evaluateInstrument(accountId, instrument, mappings[instrument], now));
    }
    return outcomes;
  }

  async evaluateInstrument(accountId: string, instrument: TrendBreakoutInstrumentId, mapping: InstrumentMapping, now: Date): Promise<InstrumentEvaluationOutcome> {
    const gates: GateResult[] = [];
    const beirut = getBeirutWallClock(now);
    const decisionAtBeirut = `${beirut.dateKey} ${String(beirut.hour).padStart(2, '0')}:${String(beirut.minute).padStart(2, '0')}:${String(beirut.second).padStart(2, '0')}`;

    // §5 — H4 warm-up needs ~166 days (1000 x 4h); fetch generously.
    const h4From = new Date(now.getTime() - 220 * 24 * 3600_000);
    const h1From = new Date(now.getTime() - 14 * 24 * 3600_000); // comfortably over the ~64-bar H1 minimum
    const [h4Raw, h1Raw] = await Promise.all([
      this.candles.getCandlesInRange(mapping.brokerSymbol, 'H4', h4From, now),
      this.candles.getCandlesInRange(mapping.brokerSymbol, 'H1', h1From, now),
    ]);
    // §5 — "never use a still-forming H4/H1 candle" — defensive filter even though HistoricalCandleService should only ever store completed bars.
    const h4Candles = h4Raw.filter((c) => c.openTime.getTime() + 4 * 3600_000 <= now.getTime());
    const h1Candles = h1Raw.filter((c) => c.openTime.getTime() + 3600_000 <= now.getTime());

    const signal = evaluateTrendBreakoutSignal({ h4Candles, h1Candles });
    gates.push(...signal.gateResults);

    if (!signal.direction || !signal.h1 || signal.atr === null) {
      return this.logHold(accountId, instrument, signal.h1?.signalCloseAt ?? now, now, decisionAtBeirut, signal, gates, 'No qualifying setup.');
    }

    const direction = signal.direction;
    const h1 = signal.h1;
    const h4 = signal.h4!;
    const signalCloseAt = h1.signalCloseAt;

    // §8 — expiry, checked immediately, before any other gate.
    if (isSignalExpired(signalCloseAt, now)) {
      gates.push(failGate('setup_expiry', `Setup expired: signal closed at ${signalCloseAt.toISOString()}, now is ${now.toISOString()} (>= 60s).`));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Setup expired (60s window elapsed).');
    }
    gates.push(passGate('setup_expiry', 'Within the 60s setup expiry window.'));

    // §4 — schedule, re-checked immediately before submission (this IS "immediately before").
    if (!isWithinEntryWindow(now)) {
      gates.push(failGate('entry_schedule', `Outside the Beirut 03:00-12:00 entry window (local time ${decisionAtBeirut}).`));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Outside the Beirut entry window.');
    }
    gates.push(passGate('entry_schedule', `Within the Beirut entry window (local time ${decisionAtBeirut}).`));

    // §3 — the instrument's slot must be free.
    if (await this.slotLock.isOccupied(accountId, instrument)) {
      gates.push(failGate('instrument_slot', `${instrument}'s entry slot is already occupied.`));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, `${instrument} slot occupied.`);
    }
    gates.push(passGate('instrument_slot', `${instrument}'s entry slot is free.`));

    // Live quote.
    const tick = await this.candles.getLiveTick(mapping.brokerSymbol, now, this.config.get<number>('TREND_BREAKOUT_MAX_QUOTE_AGE_MS') ?? 300_000);
    const riskPolicy = await this.riskPolicySettings.getActive();
    if (!tick) {
      gates.push(failGate('quote_availability', `No fresh live quote for ${mapping.brokerSymbol} — failing closed.`));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'No live quote available.');
    }
    const quoteAgeMs = now.getTime() - tick.tickAt.getTime();
    const quoteAgeGate = evaluateQuoteAgeGate({ quoteAgeMs, maxQuoteAgeSeconds: riskPolicy.maxQuoteAgeSeconds });
    gates.push(quoteAgeGate);
    if (!quoteAgeGate.passed) {
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, quoteAgeGate.reason, tick);
    }

    const executablePrice = selectExecutablePrice(direction, { bid: tick.bid, ask: tick.ask, quotedAt: tick.tickAt });
    const gapCheckResult = checkGapChaseFilter(executablePrice, h1.signalClose, signal.atr);
    const gapCheck = { gate: 'gap_chase_filter', ...gapCheckResult };
    gates.push(gapCheck);
    if (!gapCheck.passed) {
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, gapCheck.reason, tick);
    }

    // §2/§10 — symbol metadata (broker price increment, volume limits, contract spec) is REQUIRED; fail closed if absent.
    const metadata = await this.symbolMetadata.get(mapping.brokerSymbol);
    if (!metadata) {
      gates.push(failGate('symbol_metadata', `No broker symbol metadata for ${mapping.brokerSymbol} yet — cannot validate price increment/volume/contract size, failing closed.`));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Symbol metadata unavailable.', tick);
    }
    gates.push(passGate('symbol_metadata', `Symbol metadata available for ${mapping.brokerSymbol} (updated ${metadata.updatedAt.toISOString()}).`));

    const sltp = computeRoundedSlTp(direction, executablePrice, signal.atr, metadata.point);
    if (isSlTpError(sltp)) {
      gates.push(failGate('sl_tp_rounding', sltp.error));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, sltp.error, tick);
    }
    gates.push(passGate('sl_tp_rounding', `SL/TP computed and rounded to the broker's ${metadata.point} increment.`));

    const spreadPrice = tick.ask - tick.bid;
    const spreadGate = evaluateSpreadGate({ spreadPrice, stopDistancePrice: sltp.roundedStopDistance, maxSpreadPctOfD: riskPolicy.maxSpreadPctOfD });
    gates.push(spreadGate);
    if (!spreadGate.passed) {
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, spreadGate.reason, tick, sltp);
    }

    const volumeSetting = await this.volumeSettings.getOrBootstrap(instrument);
    const volumeGate = this.validateVolumeAgainstMetadata(volumeSetting.volumeLots, metadata);
    gates.push(volumeGate);
    if (!volumeGate.passed) {
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, volumeGate.reason, tick, sltp);
    }

    // §10 — account state (equity, currency) is REQUIRED; fail closed if absent.
    const [account, latestSnapshot] = await Promise.all([
      this.prisma.tradingAccount.findUnique({ where: { id: accountId }, select: { currency: true } }),
      this.prisma.accountSnapshot.findFirst({ where: { accountId }, orderBy: { capturedAt: 'desc' } }),
    ]);
    if (!account || !latestSnapshot) {
      gates.push(failGate('account_state', 'No account or no recent account snapshot (equity) available — failing closed.'));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Account equity unavailable.', tick, sltp);
    }
    gates.push(passGate('account_state', `Account equity ${latestSnapshot.equity.toString()} ${account.currency} as of ${latestSnapshot.capturedAt.toISOString()}.`));

    const currentEquity = latestSnapshot.equity.toNumber();
    let conversionRate: number | null = 1;
    if (metadata.profitCurrency !== account.currency) {
      const eurUsdTick = await this.candles.getLiveTick('EURUSD', now);
      conversionRate = resolveConversionRate({ profitCurrency: metadata.profitCurrency, accountCurrency: account.currency, eurUsdMid: eurUsdTick ? (eurUsdTick.bid + eurUsdTick.ask) / 2 : null });
    }
    const estimatedRisk = estimateStopRiskAmount({ volumeLots: volumeSetting.volumeLots, contractSize: metadata.contractSize, stopDistancePrice: sltp.roundedStopDistance, conversionRateToAccountCcy: conversionRate });
    if (estimatedRisk === null) {
      gates.push(failGate('risk_conversion', `Could not determine a ${metadata.profitCurrency}->${account.currency} conversion rate — failing closed rather than assuming 1:1.`));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Currency conversion unavailable.', tick, sltp);
    }

    const tradeRiskGate = evaluateTradeRiskGate({ estimatedRiskAmount: estimatedRisk, accountEquity: currentEquity, maxTradeRiskPct: riskPolicy.maxTradeRiskPct });
    gates.push(tradeRiskGate);
    if (!tradeRiskGate.passed) {
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, tradeRiskGate.reason, tick, sltp, estimatedRisk, metadata.profitCurrency);
    }

    const reservedRisk = await this.sumReservedRisk(accountId);
    const combinedGate = evaluateCombinedRiskGate({ reservedRiskAmounts: reservedRisk, newRiskAmount: estimatedRisk, accountEquity: currentEquity, maxCombinedRiskPct: riskPolicy.maxCombinedRiskPct });
    gates.push(combinedGate);
    if (!combinedGate.passed) {
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, combinedGate.reason, tick, sltp, estimatedRisk, metadata.profitCurrency);
    }

    const riskStateSnapshot = await this.riskState.getOrRoll(accountId, now, currentEquity);
    const dailyGate = evaluateDailyLossGate({
      currentEquity,
      dailyBaselineEquity: riskStateSnapshot.dailyBaselineEquity,
      dailyNetCashFlow: riskStateSnapshot.dailyNetCashFlow,
      dailyLossPct: riskPolicy.dailyLossPct,
      alreadyTriggered: riskStateSnapshot.dailyLossTriggered,
    });
    gates.push(dailyGate);
    if (!dailyGate.passed) {
      if (!riskStateSnapshot.dailyLossTriggered) await this.riskState.markDailyLossTriggered(accountId);
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, dailyGate.reason, tick, sltp, estimatedRisk, metadata.profitCurrency);
    }

    const drawdownGate = evaluateDrawdownGate({
      currentEquity,
      cashFlowAdjustedHigh: riskStateSnapshot.cashFlowAdjustedHigh,
      drawdownPct: riskPolicy.drawdownPct,
      alreadyTriggered: riskStateSnapshot.drawdownTriggered,
    });
    gates.push(drawdownGate);
    if (!drawdownGate.passed) {
      if (!riskStateSnapshot.drawdownTriggered) await this.riskState.markDrawdownTriggered(accountId, now);
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, drawdownGate.reason, tick, sltp, estimatedRisk, metadata.profitCurrency);
    }
    await this.riskState.updateEquityHigh(accountId, currentEquity - riskStateSnapshot.dailyNetCashFlow);

    // §-execution-controls — re-checked HERE, immediately before the
    // transaction that would actually queue a real order, not earlier in
    // this function (every other gate above can legitimately take a
    // meaningful amount of wall-clock time — H4/H1 candle fetches, account
    // snapshot lookups — during which an operator could have engaged the
    // kill switch or flipped the mode). Deliberately its own gate,
    // `execution_controls`, distinct from every account-protection gate
    // above: those answer "should this trade happen at all," this one
    // answers "is the strategy currently allowed to act on that decision."
    const mode = getTrendBreakoutExecutionMode();
    if (mode === 'OFF') {
      gates.push(failGate('execution_controls', 'Trend-breakout execution mode is OFF — no entries are queued for either instrument.'));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Execution mode is OFF.', tick, sltp, estimatedRisk, metadata.profitCurrency);
    }
    if (isTrendBreakoutKillSwitchActive()) {
      gates.push(failGate('execution_controls', 'Trend-breakout kill switch is active — refusing to queue an entry.'));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Kill switch is active.', tick, sltp, estimatedRisk, metadata.profitCurrency);
    }
    if (isStopNewEntriesActive()) {
      gates.push(failGate('execution_controls', 'Trend-breakout STOP NEW ENTRIES is active — refusing to queue an entry.'));
      return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'STOP NEW ENTRIES is active.', tick, sltp, estimatedRisk, metadata.profitCurrency);
    }
    gates.push(passGate('execution_controls', `Execution controls pass (mode=${mode}).`));

    if (mode === 'SHADOW') {
      // §SHADOW — full pipeline ran and every gate above genuinely passed;
      // log the REAL computed action for observability, but orderStatus
      // stays NONE (never PENDING) and no slot lock is claimed — SHADOW must
      // never place, or even reserve room for, a real order.
      return this.logShadow(accountId, instrument, direction, signalCloseAt, now, decisionAtBeirut, signal, gates, tick, sltp, executablePrice, volumeSetting, riskPolicy, estimatedRisk, metadata.profitCurrency);
    }

    // mode === 'DEMO' — all gates AND execution controls passed. All gates passed — log the decision and atomically claim the slot in
    // ONE transaction. The earlier `isOccupied` check (§3) is only a
    // fast-path optimization to avoid unnecessary work; the REAL,
    // race-proof protection is this transaction's own slot-lock INSERT,
    // which the database itself will reject with a unique-constraint
    // violation if a concurrent evaluation claimed the same slot in the
    // (however small) window between that check and here. A P2002 here is
    // therefore treated as "occupied," not as an application error.
    let decisionId: string;
    try {
      decisionId = await this.prisma.$transaction(async (tx) => {
      const decision = await tx.trendBreakoutDecision.create({
        data: {
          accountId,
          strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION,
          instrument,
          signalCloseAt,
          decisionAtUtc: now,
          decisionAtBeirut,
          action: direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
          h4CloseAt: h4.close,
          h4Ema50: h4.ema50,
          h4Ema200: h4.ema200,
          h1RangeHigh: h1.rangeHigh,
          h1RangeLow: h1.rangeLow,
          h1SignalClose: h1.signalClose,
          h1SignalHigh: h1.signalHigh,
          h1SignalLow: h1.signalLow,
          atr14: signal.atr,
          bid: tick.bid,
          ask: tick.ask,
          spreadPoints: spreadPrice,
          quoteAt: tick.tickAt,
          volumeUsed: volumeSetting.volumeLots,
          volumeConfigVersion: volumeSetting.version,
          riskPolicyVersion: riskPolicy.version,
          estimatedStopRiskAmount: estimatedRisk,
          estimatedStopRiskCcy: account.currency,
          intendedEntryPrice: executablePrice,
          intendedStopLoss: sltp.stopLoss,
          intendedTakeProfit: sltp.takeProfit,
          gateResults: gates as unknown as Prisma.InputJsonValue,
          rejectionReason: null,
          orderStatus: AutonomousOrderStatus.PENDING,
        },
      });
      await tx.trendBreakoutSlotLock.create({ data: { accountId, instrument, decisionId: decision.id, state: 'PENDING' } });
      return decision.id;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        gates.push(failGate('instrument_slot', `${instrument}'s entry slot was claimed by a concurrent request just before this one — refusing to submit a second entry.`));
        return this.logHold(accountId, instrument, signalCloseAt, now, decisionAtBeirut, signal, gates, 'Slot claimed concurrently.', tick, sltp, estimatedRisk, metadata.profitCurrency);
      }
      throw err;
    }

    this.logger.log(`${instrument} ${direction} entry queued (decision ${decisionId}) for account ${accountId} at ${executablePrice}`);
    return { instrument, action: direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL', decisionId, rejectionReason: null };
  }

  private validateVolumeAgainstMetadata(volumeLots: number, metadata: { volumeMin: number; volumeMax: number; volumeStep: number }): GateResult {
    if (volumeLots < metadata.volumeMin || volumeLots > metadata.volumeMax) {
      return failGate('volume_validation', `Configured volume ${volumeLots} is outside the broker's [${metadata.volumeMin}, ${metadata.volumeMax}] range — this trade is SKIPPED, the configured volume is never resized.`);
    }
    const steps = (volumeLots - metadata.volumeMin) / metadata.volumeStep;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return failGate('volume_validation', `Configured volume ${volumeLots} is not a valid multiple of the broker's ${metadata.volumeStep} step — this trade is SKIPPED, the configured volume is never resized.`);
    }
    return passGate('volume_validation', `Configured volume ${volumeLots} is valid against the broker's min/max/step.`);
  }

  /** §10 combined risk — every currently slot-locked decision's own estimated stop risk, for this account, none released until closure is confirmed (the slot lock's own lifetime IS the reservation). */
  private async sumReservedRisk(accountId: string): Promise<number[]> {
    const locks = await this.prisma.trendBreakoutSlotLock.findMany({
      where: { accountId },
      include: { decision: { select: { estimatedStopRiskAmount: true } } },
    });
    return locks.map((l) => l.decision.estimatedStopRiskAmount?.toNumber() ?? 0).filter((v) => v > 0);
  }

  private async logHold(
    accountId: string,
    instrument: TrendBreakoutInstrumentId,
    signalCloseAt: Date,
    now: Date,
    decisionAtBeirut: string,
    signal: ReturnType<typeof evaluateTrendBreakoutSignal>,
    gates: GateResult[],
    reason: string,
    tick?: { bid: number; ask: number; tickAt: Date } | null,
    sltp?: { stopLoss: number; takeProfit: number } | null,
    estimatedRisk?: number | null,
    riskCcy?: string | null,
  ): Promise<InstrumentEvaluationOutcome> {
    // A HOLD still needs its own durable identity to avoid re-logging the
    // SAME already-decided signal twice — if a row for this exact
    // (account, strategy, instrument, signalCloseAt) already exists, reuse
    // it rather than violating the unique constraint on a re-evaluation.
    const existing = await this.prisma.trendBreakoutDecision.findUnique({
      where: { accountId_strategyVersion_instrument_signalCloseAt: { accountId, strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION, instrument, signalCloseAt } },
    });
    if (existing) {
      return { instrument, action: 'HOLD', decisionId: existing.id, rejectionReason: existing.rejectionReason };
    }

    const decision = await this.decisionLogger.log({
      accountId,
      strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION,
      instrument,
      signalCloseAt,
      decisionAtUtc: now,
      decisionAtBeirut,
      action: 'HOLD',
      h4Close: signal.h4?.close ?? null,
      h4Ema50: signal.h4?.ema50 ?? null,
      h4Ema200: signal.h4?.ema200 ?? null,
      h1RangeHigh: signal.h1?.rangeHigh ?? null,
      h1RangeLow: signal.h1?.rangeLow ?? null,
      h1SignalClose: signal.h1?.signalClose ?? null,
      h1SignalHigh: signal.h1?.signalHigh ?? null,
      h1SignalLow: signal.h1?.signalLow ?? null,
      atr14: signal.atr,
      bid: tick?.bid ?? null,
      ask: tick?.ask ?? null,
      spreadPoints: tick ? tick.ask - tick.bid : null,
      quoteAt: tick?.tickAt ?? null,
      volumeUsed: null,
      volumeConfigVersion: null,
      riskPolicyVersion: null,
      estimatedStopRiskAmount: estimatedRisk ?? null,
      estimatedStopRiskCcy: riskCcy ?? null,
      intendedEntryPrice: sltp ? (tick ? selectExecutablePriceSafe(signal, tick) : null) : null,
      intendedStopLoss: sltp?.stopLoss ?? null,
      intendedTakeProfit: sltp?.takeProfit ?? null,
      gateResults: gates,
      rejectionReason: reason,
      orderStatus: AutonomousOrderStatus.NONE,
    });
    return { instrument, action: 'HOLD', decisionId: decision.id, rejectionReason: reason };
  }

  /**
   * SHADOW mode logging — same idempotency posture as `logHold` (re-using
   * an existing row for the same signal identity rather than violating the
   * unique constraint on re-evaluation), but logs the REAL computed
   * action/entry/SL/TP the pipeline actually approved, with `orderStatus:
   * NONE` and no `TrendBreakoutSlotLock` row created. This is what makes a
   * SHADOW-mode decision distinguishable from a HOLD purely by inspecting
   * `action` + `orderStatus` together: HOLD+NONE means "nothing to do,"
   * OPEN_BUY/OPEN_SELL+NONE means "would have traded, did not because of
   * SHADOW mode."
   */
  private async logShadow(
    accountId: string,
    instrument: TrendBreakoutInstrumentId,
    direction: 'BUY' | 'SELL',
    signalCloseAt: Date,
    now: Date,
    decisionAtBeirut: string,
    signal: ReturnType<typeof evaluateTrendBreakoutSignal>,
    gates: GateResult[],
    tick: { bid: number; ask: number; tickAt: Date },
    sltp: { stopLoss: number; takeProfit: number },
    executablePrice: number,
    volumeSetting: { volumeLots: number; version: number },
    riskPolicy: { version: number },
    estimatedRisk: number,
    riskCcy: string,
  ): Promise<InstrumentEvaluationOutcome> {
    const existing = await this.prisma.trendBreakoutDecision.findUnique({
      where: { accountId_strategyVersion_instrument_signalCloseAt: { accountId, strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION, instrument, signalCloseAt } },
    });
    if (existing) {
      return { instrument, action: existing.action === 'HOLD' ? 'HOLD' : (existing.action as 'OPEN_BUY' | 'OPEN_SELL'), decisionId: existing.id, rejectionReason: existing.rejectionReason };
    }

    const action = direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL';
    const decision = await this.decisionLogger.log({
      accountId,
      strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION,
      instrument,
      signalCloseAt,
      decisionAtUtc: now,
      decisionAtBeirut,
      action,
      h4Close: signal.h4?.close ?? null,
      h4Ema50: signal.h4?.ema50 ?? null,
      h4Ema200: signal.h4?.ema200 ?? null,
      h1RangeHigh: signal.h1?.rangeHigh ?? null,
      h1RangeLow: signal.h1?.rangeLow ?? null,
      h1SignalClose: signal.h1?.signalClose ?? null,
      h1SignalHigh: signal.h1?.signalHigh ?? null,
      h1SignalLow: signal.h1?.signalLow ?? null,
      atr14: signal.atr,
      bid: tick.bid,
      ask: tick.ask,
      spreadPoints: tick.ask - tick.bid,
      quoteAt: tick.tickAt,
      volumeUsed: volumeSetting.volumeLots,
      volumeConfigVersion: volumeSetting.version,
      riskPolicyVersion: riskPolicy.version,
      estimatedStopRiskAmount: estimatedRisk,
      estimatedStopRiskCcy: riskCcy,
      intendedEntryPrice: executablePrice,
      intendedStopLoss: sltp.stopLoss,
      intendedTakeProfit: sltp.takeProfit,
      gateResults: gates,
      rejectionReason: 'SHADOW mode — decision logged only; no order queued, no slot claimed.',
      orderStatus: AutonomousOrderStatus.NONE,
    });
    this.logger.log(`SHADOW ${instrument} ${direction} (decision ${decision.id}) for account ${accountId} at ${executablePrice} — no order queued.`);
    return { instrument, action, decisionId: decision.id, rejectionReason: null };
  }
}

function selectExecutablePriceSafe(signal: ReturnType<typeof evaluateTrendBreakoutSignal>, tick: { bid: number; ask: number }): number | null {
  if (!signal.direction) return null;
  return selectExecutablePrice(signal.direction, { bid: tick.bid, ask: tick.ask, quotedAt: new Date() });
}
