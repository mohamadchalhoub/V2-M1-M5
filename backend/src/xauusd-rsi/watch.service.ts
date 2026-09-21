/**
 * One watch cycle: reconcile, recover, observe, decide.
 *
 * Ordering inside a cycle is deliberate and is itself a requirement:
 *
 *   1. **Friday liquidation first.** Protective closure of owned exposure
 *      takes precedence over opening anything (spec §10), and it must run
 *      even when pauses or kill switches are blocking entries.
 *   2. **Recovery before trading.** A restart re-establishes continuity and
 *      reconciles persisted decisions against real broker exposure before a
 *      single entry may be submitted.
 *   3. **Reseed before observing.** The indicator is rebuilt from broker
 *      candle history when it is cold, without emitting anything for the
 *      historical bars it walks through.
 *   4. **Observe, then decide.** Ticks are replayed in order through the pure
 *      engine; whatever it emits is handed to the coordinator.
 *
 * The cycle never throws its way out of the loop: a failure is reported and
 * the next cycle tries again. Uncertain submissions are reconciled rather
 * than retried blindly.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { applyClosedBar, applyTick, createEngineState, EmittedSignal, engineRsiNow, engineWarmedUp, M1_MS } from './engine';
import { RSI_BROKER_SERVER_TIMEZONE, RSI_CURSOR_TIME_BASIS, storedBrokerTimeToUtcMs } from './tick-time';
import { utcToWallClockMs } from '../research/confirmed-retest/time';
import { RsiCoordinatorService } from './coordinator.service';
import { RsiAccountStateService } from './account-state.service';
import { RsiLiquidationService, LiquidationCycleResult } from './liquidation.service';
import { RsiDecisionService } from './decision.service';
import { RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS, RSI_OBSERVATION_INTERVAL_MS } from './safety-constants';
import { entriesBlockedByControls } from './controls';
import { GoldTelegramService } from '../gold-execution/gold-telegram.service';
import { RsiWatchState, RsiWatchStore } from './state-store';
import { SPEC } from './spec';
import { RSI_GOLD_POINT_SIZE, RSI_SYMBOL } from './safety-constants';
import { evaluateEntryEligibility } from './schedule';

/** How many ticks one cycle will consume at most, so a long backlog cannot stall a cycle indefinitely. */
const MAX_TICKS_PER_CYCLE = 5_000;

export interface WatchCycleResult {
  nowT: number;
  liquidation: LiquidationCycleResult;
  recoveryComplete: boolean;
  recoveryDetail: string | null;
  reseeded: boolean;
  ticksConsumed: number;
  signalsEmitted: EmittedSignal[];
  decisions: Array<{ decisionId: string; queued: boolean; skipReason: string | null }>;
  currentRsi: number | null;
  warmedUp: boolean;
  observationMode: string;
  notes: string[];
  entriesAllowed: boolean;
  entryBlockReason: string | null;
  /** Per-family occupancy after this cycle. */
  slots: { RETEST: { occupied: boolean; reason: string | null }; EXTREME: { occupied: boolean; reason: string | null } };
  /** Slots released this cycle because their positions are confirmed gone. */
  slotsReleased: string[];
  /** Measured gap since the previous cycle, against the one-second target. */
  cadence: { targetMs: number; measuredMs: number | null; withinTarget: boolean | null };
  /** Age of the newest observation consumed, measured at evaluation time. */
  newestObservationAgeMs: number | null;
}

@Injectable()
export class RsiWatchService {
  private readonly logger = new Logger(RsiWatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly coordinator: RsiCoordinatorService,
    private readonly accountState: RsiAccountStateService,
    private readonly liquidation: RsiLiquidationService,
    private readonly decisions: RsiDecisionService,
    /**
     * The gold Telegram channel, reused unchanged: its own bot and chat, its
     * own durable per-key deduplication, and plain factual template strings
     * with no AI narration. Every call here is fire-and-forget, because a
     * Telegram outage must never stop a trading cycle — the database already
     * holds the authoritative record of everything reported below.
     */
    private readonly telegram: GoldTelegramService,
  ) {}

  async runCycle(params: { accountId: string; store: RsiWatchStore; state: RsiWatchState; nowT?: number }): Promise<{ result: WatchCycleResult; state: RsiWatchState }> {
    const nowT = params.nowT ?? Date.now();
    let state = params.state;
    const notes: string[] = [];

    // Measured, not assumed: the gap since the previous completed cycle is
    // what actually determines how quickly a crossing can be acted on.
    const previousCycleAtT = state.recovery.lastCycleAtUtc ? Date.parse(state.recovery.lastCycleAtUtc) : null;
    const measuredCadenceMs = previousCycleAtT === null ? null : nowT - previousCycleAtT;

    // 0. Release any slot whose position the broker no longer reports. This
    //    runs FIRST so the rest of the cycle sees accurate occupancy: a trade
    //    closed by its own take-profit must free its family immediately, not
    //    on the next cycle.
    const exposureNow = await this.accountState.resolveExposure(params.accountId);
    const liveTickets = new Set(exposureNow.items.filter((i) => i.kind === 'POSITION').map((i) => i.ticket));
    const slotsReleased = await this.decisions.releaseSlotsForClosedPositions(params.accountId, liveTickets);

    // 0b. Re-send notifications that failed earlier.
    //
    // Cheap and bounded: the sweep spaces attempts a minute apart and takes a
    // small batch, so running it every cycle costs one indexed query. It sits
    // here because a lost fill alert is an operator-visibility failure, and
    // the operator needs it whether or not the rest of the cycle succeeds.
    // Wrapped, not just `.catch()`ed: this is a best-effort side task and
    // must never be able to break the trading cycle, whatever it throws.
    try {
      void this.telegram.retryFailed(new Date(nowT)).catch(() => undefined);
    } catch {
      /* retry sweep is never allowed to interrupt the cycle */
    }

    // 1. Protective work, before anything that opens exposure.
    const liquidation = await this.liquidation.runCycle(params.accountId, nowT);
    this.notifyLiquidation(liquidation);

    // 1b. Discard a cursor recorded on the pre-correction timeline.
    //
    // Before the broker wall-clock correction the cursor held a value three
    // hours ahead of what the same tick now yields. Kept, it would sit in
    // the future and filter out every new observation — the strategy would
    // look healthy and see nothing. Dropping it costs one reseed.
    // A persisted clock that sits in the FUTURE is rebuilt, whatever put it
    // there.
    //
    // This began as a one-shot migration keyed on a `timeBasis` tag, and the
    // running system proved that insufficient: the tag was stamped onto the
    // cursor by an earlier restart while the ENGINE kept its old clock, so
    // the guard stopped firing and the damage persisted. The symptom is
    // nasty because everything else looks healthy — one-second cadence,
    // ticks read, recovery complete — while `lastObservationT` sits three
    // hours ahead, every incoming tick is rejected as out-of-order, and RSI
    // stays frozen at whatever value it last held. Observed live at 42.78
    // with out-of-order rejections past 167,000.
    //
    // So the condition is now the symptom itself, not a version tag: an
    // engine whose clock is meaningfully ahead of wall clock cannot be
    // right, and is rebuilt from history. That self-heals a state file
    // poisoned by any cause, including a half-completed migration.
    //
    // The tolerance is generous compared to real clock skew, so an ordinary
    // healthy engine is never rebuilt.
    const engineClockT = Math.max(state.engine.lastObservationT ?? 0, state.engine.lastClosedBarT ?? 0);
    const engineClockAheadMs = engineClockT - nowT;
    const basisStale = state.cursor.timeBasis !== RSI_CURSOR_TIME_BASIS;
    if (engineClockAheadMs > RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS || (basisStale && state.cursor.lastTimestampMs !== null)) {
      notes.push(
        engineClockAheadMs > RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS
          ? `engine clock is ${(engineClockAheadMs / 1000).toFixed(0)}s in the FUTURE (limit ${RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS / 1000}s) — ` +
              'indicator and cursor discarded and rebuilt from history, because every new observation would otherwise be rejected as out-of-order'
          : `observation cursor was recorded on an older time basis (${state.cursor.timeBasis ?? 'untagged'}) — discarded and rebuilt from history`,
      );
      state = {
        ...state,
        // Rebuilding forces reseedFromCandles, which converts candle times
        // the same way ticks are converted, so the indicator and the
        // observations end up on one timeline. Pattern state is dropped on
        // purpose: a pattern half-formed on a different timeline is not one
        // this engine may trade.
        engine: createEngineState(state.engine.observationMode),
        cursor: { lastTimestampMs: null, lastTickKey: null, lastTimestampKeys: [], timeBasis: RSI_CURSOR_TIME_BASIS },
      };
    }

    // 2. Recovery.
    if (!state.recovery.recoveryComplete) {
      const recovery = await this.reconcileOnStartup(params.accountId, nowT);
      state = { ...state, recovery: { ...state.recovery, recoveryComplete: recovery.complete, lastRecoveryDetail: recovery.detail } };
      notes.push(`recovery: ${recovery.detail}`);
    }

    // 3. Reseed the indicator from broker candle history when it is cold.
    let reseeded = false;
    if (!engineWarmedUp(state.engine)) {
      const seed = await this.reseedFromCandles(state);
      // The observation cursor must be moved to the end of the seeded range.
      //
      // Seeding leaves the engine's own clock at the last closed bar it
      // applied. Any tick older than that is, by definition, already inside
      // the indicator and would be rejected as out-of-order — so leaving the
      // cursor behind the seed point makes the loop re-read and discard the
      // same historical ticks on every cycle, forever. Observed live on a
      // cold start: 44,992 ticks read, 44,992 rejected, none applied.
      const cursorFloor = seed.lastSeededBarEndT;
      const cursor =
        cursorFloor !== null && (state.cursor.lastTimestampMs === null || state.cursor.lastTimestampMs < cursorFloor)
          ? { lastTimestampMs: cursorFloor, lastTickKey: null, lastTimestampKeys: [], timeBasis: RSI_CURSOR_TIME_BASIS }
          : state.cursor;
      state = {
        ...state,
        engine: seed.engine,
        cursor,
        recovery: { ...state.recovery, lastReseedAtUtc: new Date(nowT).toISOString() },
      };
      reseeded = true;
      notes.push(seed.detail);
    }

    // 4. Observe.
    const session = await this.accountState.resolveBrokerSessionOpen(new Date(nowT));
    const ticks = await this.readNewTicks(state.cursor.lastTimestampMs, state.cursor.lastTimestampKeys);

    const signalsEmitted: EmittedSignal[] = [];
    const decisions: WatchCycleResult['decisions'] = [];
    let cursor = state.cursor;
    let engine = state.engine;

    for (const tick of ticks) {
      const step = applyTick(engine, {
        atT: tick.timestampMs,
        bid: tick.bid,
        tickKey: tick.key,
        // Freshness is judged against wall clock, not against the tick's own
        // time, so replaying a backlog cannot produce live entries from
        // observations that are already minutes old.
        nowT,
      });
      engine = step.state;
      if (step.notes.length > 0) notes.push(...step.notes.slice(0, 3));

      cursor =
        tick.timestampMs === cursor.lastTimestampMs
          ? { ...cursor, lastTickKey: tick.key, lastTimestampKeys: [...cursor.lastTimestampKeys, tick.key] }
          : { lastTimestampMs: tick.timestampMs, lastTickKey: tick.key, lastTimestampKeys: [tick.key], timeBasis: RSI_CURSOR_TIME_BASIS };

      for (const signal of step.signals) {
        signalsEmitted.push(signal);
        const executablePrice = signal.direction === 'BUY' ? tick.ask : tick.bid;
        const outcome = await this.coordinator.evaluate(signal, {
          accountId: params.accountId,
          nowT,
          currentExecutablePrice: executablePrice,
          brokerSessionOpen: session.open,
          brokerSessionDetail: session.detail,
          dataFresh: session.open === true,
          recoveryComplete: state.recovery.recoveryComplete,
        });
        decisions.push({ decisionId: outcome.decisionId, queued: outcome.queued, skipReason: outcome.skipReason });
        this.notifyDecision(signal, outcome.decisionId, outcome.queued, outcome.skipReason);
      }
    }

    state = {
      ...state,
      engine,
      cursor,
      recovery: {
        ...state.recovery,
        lastCycleAtUtc: new Date(nowT).toISOString(),
        cadenceSamplesMs:
          measuredCadenceMs === null
            ? (state.recovery.cadenceSamplesMs ?? [])
            : [...(state.recovery.cadenceSamplesMs ?? []), measuredCadenceMs].slice(-120),
      },
    };

    // The CONTROLS belong in this answer, not just the clock.
    //
    // This passed `otherBlock: null`, so the cycle line reported
    // "entries=allowed" while the kill switch was engaged and the execution
    // mode was OFF. The controls were still enforced - the coordinator and
    // the pre-send check both call entriesBlockedByControls() and refuse -
    // so nothing could actually trade. But an operator reading the log saw
    // "allowed" on a system that was fully blocked, which is exactly the
    // kind of readout that gets someone to act on a wrong belief. Observed
    // on the first server deployment.
    const eligibility = evaluateEntryEligibility({
      utcMs: nowT,
      brokerSessionOpen: session.open,
      dataFresh: session.open === true,
      recoveryComplete: state.recovery.recoveryComplete,
      otherBlock: entriesBlockedByControls(),
    });

    const slots = await this.accountState.resolveSlotStates(params.accountId);
    const newestObservationT = ticks.length > 0 ? ticks[ticks.length - 1].timestampMs : state.cursor.lastTimestampMs;

    return {
      state,
      result: {
        nowT,
        liquidation,
        slots: {
          RETEST: { occupied: slots.RETEST.occupied, reason: slots.RETEST.reason },
          EXTREME: { occupied: slots.EXTREME.occupied, reason: slots.EXTREME.reason },
        },
        slotsReleased,
        cadence: {
          targetMs: RSI_OBSERVATION_INTERVAL_MS,
          measuredMs: measuredCadenceMs,
          withinTarget:
            measuredCadenceMs === null ? null : measuredCadenceMs <= RSI_OBSERVATION_INTERVAL_MS + 2_000,
        },
        newestObservationAgeMs: newestObservationT === null ? null : nowT - newestObservationT,
        recoveryComplete: state.recovery.recoveryComplete,
        recoveryDetail: state.recovery.lastRecoveryDetail,
        reseeded,
        ticksConsumed: ticks.length,
        signalsEmitted,
        decisions,
        currentRsi: engineRsiNow(engine),
        warmedUp: engineWarmedUp(engine),
        observationMode: engine.observationMode,
        notes,
        entriesAllowed: eligibility.entriesAllowed,
        entryBlockReason: eligibility.blockReason,
      },
    };
  }


  /**
   * Reports the Friday liquidation's state transitions.
   *
   * Deduplicated per deadline and phase, so a worker cycling every few
   * seconds through a half-hour liquidation window sends at most one message
   * per meaningful change rather than hundreds. A missed deadline is reported
   * once per deadline, and it names the remaining exposure.
   */
  private notifyLiquidation(liquidation: LiquidationCycleResult): void {
    if (liquidation.phase === 'NOT_DUE') return;
    const deadlineKey = liquidation.deadlineAtT ?? 0;

    if (liquidation.criticalIncident) {
      void this.telegram.notify(
        'FRIDAY_LIQUIDATION_DEADLINE_MISSED',
        `rsi-liq-missed:${deadlineKey}`,
        `XAUUSD RSI — CRITICAL: ${liquidation.criticalIncident}`,
      );
      return;
    }

    if (liquidation.phase === 'IN_PROGRESS' && liquidation.closeRequestsCreated.length > 0) {
      void this.telegram.notify(
        'FRIDAY_LIQUIDATION_STARTED',
        `rsi-liq-started:${deadlineKey}`,
        `XAUUSD RSI — Friday pre-weekend liquidation started. Deadline ${liquidation.deadlineLabel}. ` +
          `Owned items to clear: ${liquidation.outstanding.map((i) => i.ticket).join(', ') || 'none itemised'}. ` +
          'Closure is only reported once the broker confirms it.',
      );
    }

    if (liquidation.phase === 'CONFIRMED_FLAT' && liquidation.confirmedCleared.length > 0) {
      void this.telegram.notify(
        'FRIDAY_LIQUIDATION_CONFIRMED',
        `rsi-liq-confirmed:${deadlineKey}`,
        `XAUUSD RSI — Friday liquidation complete. Broker confirms no owned XAUUSD exposure remains ` +
          `(cleared: ${liquidation.confirmedCleared.join(', ')}). ` +
          (liquidation.foreignExposure.length > 0
            ? `NOTE: ${liquidation.foreignExposure.length} foreign/manual position(s) remain and were deliberately NOT closed.`
            : 'No foreign or manual XAUUSD exposure was present.'),
      );
    }
  }

  /**
   * Reports entries and the skips worth knowing about.
   *
   * Routine, expected skips — the daily pause, the Friday cutoff, the
   * one-position occupancy rule — are NOT sent. They are recorded in the
   * decision table and shown on the dashboard, and sending them would flood
   * the channel with messages describing the strategy working as designed,
   * which is exactly how genuinely important messages get ignored.
   *
   * A skip that indicates something an operator may need to act on — a risk
   * cap reached, a control engaged, a broker constraint refused — is sent.
   */
  private notifyDecision(signal: EmittedSignal, decisionId: string, queued: boolean, skipReason: string | null): void {
    if (queued) {
      void this.telegram.notify(
        'SIGNAL_QUEUED',
        `rsi-queued:${decisionId}`,
        `XAUUSD RSI — ${signal.family} ${signal.direction} queued for the broker. setups=${signal.kinds.join('+')} ` +
          `rsi=${signal.rsi.toFixed(2)} decision=${decisionId}. The ${signal.family} slot is now reserved. ` +
          'A fill is only reported once the broker confirms it.',
      );
      return;
    }

    if (!skipReason) return;
    const routine = /DAILY_PAUSE|FRIDAY_ENTRY_CUTOFF|slot is already held|Execution mode is OFF|SHADOW mode/i;
    if (routine.test(skipReason)) return;

    void this.telegram.notify(
      'SIGNAL_SKIPPED',
      `rsi-skipped:${decisionId}`,
      `XAUUSD RSI — ${signal.family} ${signal.direction} NOT taken. setups=${signal.kinds.join('+')} ` +
        `rsi=${signal.rsi.toFixed(2)} reason=${skipReason}`,
    );
  }

  /**
   * Startup/reconnect reconciliation.
   *
   * Resolves anything this strategy left in flight against REAL broker state:
   * a decision still `PENDING` was never sent and is retired; a decision
   * `SENT` or `UNKNOWN` may or may not have reached the broker, so it is
   * matched against actual open positions rather than assumed either way.
   *
   * Entries stay blocked until this completes — spec §9.4's "recovery/
   * reconciliation is complete" gate.
   */
  private async reconcileOnStartup(accountId: string, nowT: number): Promise<{ complete: boolean; detail: string }> {
    const inFlight = await this.prisma.xauusdRsiDecision.findMany({
      where: { accountId, orderStatus: { in: ['PENDING', 'SENT', 'UNKNOWN'] } },
      orderBy: { evaluatedAt: 'asc' },
    });
    if (inFlight.length === 0) {
      return { complete: true, detail: 'No in-flight decisions to reconcile.' };
    }

    const exposure = await this.accountState.resolveExposure(accountId);
    const liveTickets = new Set(exposure.items.filter((i) => i.kind === 'POSITION').map((i) => i.ticket));
    const parts: string[] = [];

    // Before judging anything unresolved, give a ticketless in-flight
    // decision the chance to be identified from broker evidence, and release
    // any holder the broker confirms is closed. Without this, a restart
    // turned a decision whose result report was lost into a permanent
    // UNKNOWN that held its family's slot forever — which is exactly what
    // happened to the RETEST slot after 966bf32f's fill report was rejected.
    const reconciled = await this.decisions.releaseSlotsForClosedPositions(accountId, liveTickets);
    if (reconciled.length > 0) parts.push(`reconciled against broker evidence: ${reconciled.join(', ')}`);

    // Re-read, because the step above may have resolved some of them.
    const stillInFlight = await this.prisma.xauusdRsiDecision.findMany({
      where: { accountId, orderStatus: { in: ['PENDING', 'SENT', 'UNKNOWN'] }, slotReleasedAt: null },
      orderBy: { evaluatedAt: 'asc' },
    });

    for (const decision of stillInFlight) {
      if (decision.orderStatus === 'PENDING') {
        // Never sent — retiring it is safe and is what spec §10 asks for
        // ("Retire unsent old-strategy intentions with audit reasons").
        await this.prisma.xauusdRsiDecision.update({
          where: { id: decision.id },
          data: {
            orderStatus: 'NONE',
            approved: false,
            skipReason: `Retired during startup reconciliation at ${new Date(nowT).toISOString()}: the process restarted before this queued entry was ever sent, and an intrabar signal is not valid to submit later.`,
          },
        });
        parts.push(`retired unsent decision ${decision.id}`);
        continue;
      }

      // SENT or UNKNOWN: the outcome is genuinely uncertain.
      if (decision.mt5Ticket !== null && liveTickets.has(String(decision.mt5Ticket))) {
        await this.prisma.xauusdRsiDecision.update({
          where: { id: decision.id },
          data: { orderStatus: 'FILLED', filledAt: decision.filledAt ?? new Date(nowT) },
        });
        parts.push(`confirmed decision ${decision.id} is FILLED (ticket ${decision.mt5Ticket} is open at the broker)`);
        continue;
      }

      // No matching open position. That is NOT proof it never filled — it may
      // have filled and already closed. It is therefore marked UNKNOWN and
      // left for an operator, never silently marked failed, because marking
      // it failed would free the occupancy slot on an assumption.
      await this.prisma.xauusdRsiDecision.update({
        where: { id: decision.id },
        data: {
          orderStatus: 'UNKNOWN',
          executionError:
            (decision.executionError ? `${decision.executionError} | ` : '') +
            `Startup reconciliation at ${new Date(nowT).toISOString()} found no matching open position. This does not prove the order never filled — it may have filled and closed. Requires operator confirmation against the broker's own deal history.`,
        },
      });
      parts.push(`decision ${decision.id} remains UNKNOWN and needs operator confirmation`);
    }

    const unresolved = await this.prisma.xauusdRsiDecision.count({
      where: { accountId, orderStatus: 'UNKNOWN' },
    });

    if (unresolved > 0) {
      return {
        complete: false,
        detail: `${parts.join('; ')}. ${unresolved} decision(s) remain UNKNOWN — new entries stay blocked until these are resolved against the broker's deal history.`,
      };
    }
    return { complete: true, detail: parts.join('; ') || 'Reconciliation complete.' };
  }

  /**
   * Rebuilds the indicator from the broker's own closed M1 candles.
   *
   * Walks history through the engine so the Wilder average converges exactly
   * as it would have live, but emits nothing: `applyClosedBar` never produces
   * signals, so no historical bar can ever be submitted as a live entry
   * (spec §7's "warm up without submitting historical signals").
   *
   * Only a CONTIGUOUS run of the most recent bars is used. A gap in history
   * would make the resulting average one no real sequence produced, so the
   * seed starts after the most recent gap instead of bridging it.
   */
  private async reseedFromCandles(state: RsiWatchState): Promise<{ engine: RsiWatchState['engine']; detail: string; lastSeededBarEndT: number | null }> {
    const required = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
    const rows = await this.prisma.historicalCandle.findMany({
      where: { symbol: RSI_SYMBOL, timeframe: 'M1' },
      orderBy: { openTime: 'desc' },
      take: required + 200,
      select: { openTime: true, close: true },
    });
    if (rows.length === 0) {
      return {
        engine: state.engine,
        detail: 'No M1 candle history available — the indicator cannot be seeded, so signals stay suppressed.',
        lastSeededBarEndT: null,
      };
    }

    // Candle `open_time` carries the SAME broker wall-clock mislabeling as
    // tick timestamps (see tick-time.ts), and is corrected the same way. It
    // has to be: the engine compares a seeded bar's clock against incoming
    // tick timestamps, so seeding on one timeline and observing on another
    // would make every live tick look three hours out of order.
    const ascending = rows
      .slice()
      .reverse()
      .map((row) => ({ t: storedBrokerTimeToUtcMs(row.openTime.getTime()), close: row.close }))
      .filter((row): row is { t: number; close: (typeof rows)[number]['close'] } => row.t !== null);

    if (ascending.length === 0) {
      return {
        engine: state.engine,
        detail: 'No usable M1 candle history after timestamp conversion — the indicator cannot be seeded, so signals stay suppressed.',
        lastSeededBarEndT: null,
      };
    }

    // Trim to the most recent contiguous run.
    let startIndex = 0;
    for (let i = 1; i < ascending.length; i += 1) {
      const gap = ascending[i].t - ascending[i - 1].t;
      if (gap !== M1_MS) startIndex = i;
    }
    const contiguous = ascending.slice(startIndex);

    let engine = createEngineState(state.engine.observationMode);
    for (const row of contiguous) {
      // advancePattern = false: seeding makes RSI computable, and must not
      // leave a frozen trough or peak that a live tick could retest.
      engine = applyClosedBar(engine, row.t, row.close.toNumber(), false).state;
    }

    const warmed = engineWarmedUp(engine);
    const lastBar = contiguous[contiguous.length - 1];
    const detail = warmed
      ? `Indicator seeded from ${contiguous.length} contiguous closed M1 bars ending ${new Date(lastBar.t).toISOString()}; warm-up satisfied.`
      : `Indicator seeded from ${contiguous.length} contiguous closed M1 bars, which is short of the ${required} required — signals stay suppressed until more history is available.`;
    return { engine, detail, lastSeededBarEndT: lastBar.t + M1_MS };
  }

  /**
   * Reads ordered broker ticks newer than the cursor.
   *
   * `HistoricalTick` is the collector's own ingested tick store, deduplicated
   * at the database level, so this is genuine ordered broker tick data rather
   * than a periodic quote sample. Same-millisecond ties are resolved with the
   * cursor's key list so an overlapping refetch cannot re-process a tick.
   */
  private async readNewTicks(
    lastTimestampMs: number | null,
    lastTimestampKeys: string[],
  ): Promise<Array<{ timestampMs: number; bid: number; ask: number; key: string }>> {
    // The cursor is kept in TRUE UTC; the column is stored in broker
    // wall-clock (see tick-time.ts). The query bound is therefore converted
    // back into the stored space, so the database still does the filtering
    // on its own index instead of this process reading everything.
    const boundWallMs =
      lastTimestampMs !== null ? utcToWallClockMs(RSI_BROKER_SERVER_TIMEZONE, lastTimestampMs) : null;

    const rows = await this.prisma.historicalTick.findMany({
      where: {
        symbol: RSI_SYMBOL,
        ...(boundWallMs !== null ? { timestamp: { gte: new Date(boundWallMs) } } : {}),
      },
      orderBy: [{ timestamp: 'asc' }, { batchSeq: 'asc' }, { id: 'asc' }],
      take: MAX_TICKS_PER_CYCLE,
      select: { id: true, timestamp: true, bid: true, ask: true, batchSeq: true },
    });

    const consumed = new Set(lastTimestampKeys);
    const out: Array<{ timestampMs: number; bid: number; ask: number; key: string }> = [];
    for (const row of rows) {
      const storedMs = row.timestamp.getTime();
      // Identity stays anchored to the STORED value and the row id, so a
      // tick's key never changes and re-reading one can never look new.
      const key = `${storedMs}:${row.id.toString()}`;
      const timestampMs = storedBrokerTimeToUtcMs(storedMs);
      if (timestampMs === null) continue;
      if (lastTimestampMs !== null && timestampMs === lastTimestampMs && consumed.has(key)) continue;
      if (lastTimestampMs !== null && timestampMs < lastTimestampMs) continue;
      const bid = row.bid.toNumber();
      const ask = row.ask.toNumber();
      if (!(bid > 0) || !(ask > 0)) continue;
      out.push({ timestampMs, bid, ask, key });
    }
    return out;
  }
}

export { RSI_GOLD_POINT_SIZE };
