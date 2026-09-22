/**
 * The manually started observation process for
 * `xauusd-m1-m5-rsi-threshold-v2`.
 *
 * Usage: `npm run xauusd-m1m5:scheduler`
 *
 * Reads from the environment:
 *   XAUUSD_M1M5_EXECUTION_MODE              OFF (default) | SHADOW | DEMO
 *   XAUUSD_M1M5_OBSERVATION_INTERVAL_SECONDS  default 1
 *   XAUUSD_M1M5_STATE_DIR                   default <backend>/xauusd-m1m5-runtime
 *   XAUUSD_M1M5_ACCOUNT_ID                  the one DEMO account to trade
 *
 * This process is started BY HAND. Nothing installs it as a service, a
 * scheduled task or a reboot autostart -- that is a deliberate requirement
 * (section 14), and it has a consequence the operator must understand:
 *
 *   WHILE THIS PROCESS IS NOT RUNNING, NOTHING OBSERVES RSI, NOTHING ENTERS,
 *   AND THE FRIDAY PRE-WEEKEND LIQUIDATION DOES NOT RUN.
 *
 * Ctrl+C / SIGTERM stops cleanly and saves state.
 *
 * ## Why the loop is self-scheduling rather than setInterval
 *
 * `setInterval` at one second, against a cycle that occasionally takes longer
 * than one second, queues cycles behind each other and drifts without ever
 * saying so. This loop measures each cycle and schedules the next one from
 * when the previous finished, so the measured interval reported to the
 * dashboard is the truth about cadence rather than the configured hope.
 *
 * ## Errors do not stop the loop
 *
 * Section 14 requires the application to keep observing after wins, losses,
 * skips, rejections and recoverable errors. A cycle that throws is logged,
 * counted and followed by the next cycle. What it must never do is advance
 * state as though it had succeeded, which is why `runCycle` is pure and its
 * result is only persisted on the success path.
 */
import { PrismaClient } from '@prisma/client';
import { getM1M5ExecutionMode, entriesBlockedByControls, killSwitchState } from '../src/xauusd-m1m5/controls';
import { createEngineState } from '../src/xauusd-m1m5/engine';
import { rewarmColdTimeframes, warmTimeframeFromHistory, WARMUP_BARS_NEEDED } from '../src/xauusd-m1m5/warmup';
import { isWarmedUp } from '../src/xauusd-m1m5/rsi';
import { createLockSet, type LockSet } from '../src/xauusd-m1m5/locks';
import { M1M5OccupancyService } from '../src/xauusd-m1m5/occupancy.service';
import { M1M5ExecutionService } from '../src/xauusd-m1m5/execution.service';
import { M1M5Mt5SnapshotService } from '../src/xauusd-m1m5/mt5-snapshot.service';
import { M1M5QueueingBrokerPort } from '../src/xauusd-m1m5/queue-broker.port';
import { buildExecutionContext } from '../src/xauusd-m1m5/execution-context';
import { resolveVolume } from '../src/xauusd-m1m5/volume';
import { buildBrokerSnapshot } from '../src/xauusd-m1m5/broker-snapshot';
import { M1M5ReconciliationService, type ProtectionIssue } from '../src/xauusd-m1m5/reconciliation.service';
import { M1M5ProtectionService } from '../src/xauusd-m1m5/protection.service';
import { M1M5ReportingService } from '../src/xauusd-m1m5/reporting.service';
import { M1M5TelegramService } from '../src/xauusd-m1m5/telegram.service';
import {
  lockReleasedMessage,
  liquidationCompleteMessage,
  liquidationFailedMessage,
  skippedMessage,
  submittedMessage,
} from '../src/xauusd-m1m5/telegram-messages';
import { M1M5LiquidationService } from '../src/xauusd-m1m5/liquidation.service';
import {
  M1M5CloseRequestService,
  M1M5QueueingLiquidationBroker,
} from '../src/xauusd-m1m5/close-request.service';
import { evaluateEntryEligibility } from '../src/xauusd-m1m5/schedule';
import { V2_QUOTE_MAX_STALENESS_SECONDS } from '../src/xauusd-m1m5/safety-constants';
import { readQuoteCandidates } from '../src/xauusd-m1m5/quote-sources';
import { describeCycle, runCycle } from '../src/xauusd-m1m5/watch-cycle';
import { defaultStateDir, readWatchState, writeWatchState, type WatchState } from '../src/xauusd-m1m5/state-store';
import { SPEC, SPEC_HASH, TIMEFRAMES, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from '../src/xauusd-m1m5/spec';
import { beirutDateKey, beirutLabel } from '../src/xauusd-m1m5/time';
import { assertMagicNumbersAreDisjoint } from '../src/xauusd-m1m5/ownership';
import { V2_OBSERVATION_INTERVAL_MS } from '../src/xauusd-m1m5/safety-constants';

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

/**
 * How often broker state is reconciled once the loop is running.
 *
 * Not every cycle: a one-second reconciliation would query the broker snapshot
 * and the whole decision table sixty times a minute to notice a change that
 * arrives at the collector's own, slower cadence. Thirty seconds is well
 * inside the Friday liquidation window and far quicker than any closure needs
 * to be noticed.
 */
const RECONCILE_INTERVAL_MS = 30_000;

/** How long a reconciliation drought must last before it is worth saying so. */
const RECONCILE_STALE_WARN_MS = 5 * 60_000;

function intervalMs(): number {
  const raw = Number(process.env.XAUUSD_M1M5_OBSERVATION_INTERVAL_SECONDS);
  if (Number.isFinite(raw) && raw > 0) return raw * 1000;
  return V2_OBSERVATION_INTERVAL_MS;
}

/**
 * Loads persisted state, or builds fresh state and warms the indicators from
 * closed historical bars.
 *
 * Warm-up commits bars to the RSI state and never touches the crossing state,
 * so it cannot produce an entry -- not because a flag suppresses it, but
 * because the code path that forms signals is never entered (section 3.3,
 * section 11).
 */
async function loadOrWarmState(prisma: PrismaClient, accountId: string | null): Promise<WatchState> {
  const existing = readWatchState();
  if (existing) {
    log('Resumed persisted observation state.');
    // A resumed state is not necessarily a warm one: the first start may have
    // run before the collector finished downloading history, and resuming
    // would then keep that under-warmed state forever. See warmup.ts.
    const { state, rewarmed } = await rewarmColdTimeframes(prisma, existing);
    for (const r of rewarmed) {
      log(
        `${r.timeframe}: resumed state was NOT warm (${r.fromBars}/${WARMUP_BARS_NEEDED} closed bars); ` +
          `re-warmed from ${r.toBars} historical bars. Crossing state reset, so nothing is armed by this.`,
      );
    }
    for (const tf of TIMEFRAMES) {
      if (!isWarmedUp(state.engines[tf].rsi)) {
        log(
          `${tf}: still warming (${state.engines[tf].rsi.closedBarCount}/${WARMUP_BARS_NEEDED} closed bars) -- ` +
            'this timeframe cannot signal until it is warm.',
        );
      }
    }
    return state;
  }
  log('No usable persisted state (absent, corrupt, or written under different rules). Warming from history.');

  const engines = { M1: createEngineState('M1'), M5: createEngineState('M5') };
  for (const tf of TIMEFRAMES) {
    const { engine, bars } = await warmTimeframeFromHistory(prisma, tf);
    engines[tf] = engine;
    log(`${tf}: warmed from ${bars} closed bars (${WARMUP_BARS_NEEDED} needed before any signal may form).`);
  }

  return {
    strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
    specHash: SPEC_HASH,
    accountId,
    lastCycleAtMs: Date.now(),
    lastCycleIntervalMs: null,
    lastSubmissionLatencyMs: null,
    engines,
    crossings: { M1: engines.M1.crossing, M5: engines.M5.crossing },
    observationLimitations: [],
    recoveryCompleteAtMs: Date.now(),
  };
}

async function main() {
  // Refuses to start on a magic-number collision rather than trading into one.
  assertMagicNumbersAreDisjoint();

  const prisma = new PrismaClient();
  // Constructed directly rather than through Nest. This process deliberately
  // is not a Nest application (see the header): booting the API must not be
  // able to start trading, so the observation loop cannot live inside it.
  // These services take their collaborators as constructor arguments precisely
  // so they work in both settings.
  const occupancy = new M1M5OccupancyService(prisma);
  const snapshots = new M1M5Mt5SnapshotService(prisma);
  const execution = new M1M5ExecutionService(prisma, occupancy, new M1M5QueueingBrokerPort());
  const reconciliation = new M1M5ReconciliationService(prisma, occupancy);
  const closeRequests = new M1M5CloseRequestService(prisma);
  const protection = new M1M5ProtectionService(prisma);
  const telegram = new M1M5TelegramService(prisma);
  const reporting = new M1M5ReportingService(prisma, telegram);
  const accountId = process.env.XAUUSD_M1M5_ACCOUNT_ID?.trim() || null;
  const expectedLoginId = process.env.MT5_EXPECTED_LOGIN?.trim() || null;
  // The broker LOGIN, not the internal account row id: that is what an
  // operator can check against the terminal in front of them.
  const messageCtx = { accountLabel: `DEMO ${expectedLoginId ?? accountId ?? 'unconfigured'}` };
  // Bound to this one account. `LiquidationBrokerPort` has no account
  // parameter by design, so binding it here is what makes the liquidation
  // service structurally unable to reach an account it was not pointed at.
  const liquidation = accountId
    ? new M1M5LiquidationService(
        prisma,
        new M1M5QueueingLiquidationBroker(prisma, closeRequests, accountId),
      )
    : null;
  const mode = getM1M5ExecutionMode();
  const cycleMs = intervalMs();

  log(`${XAUUSD_M1M5_STRATEGY_VERSION} observation loop starting.`);
  log(`  spec hash     : ${SPEC_HASH}`);
  log(`  execution mode: ${mode}`);
  log(`  interval      : ${cycleMs}ms`);
  log(`  account       : ${accountId ?? 'NOT CONFIGURED - observation only'}`);
  log(`  Beirut now    : ${beirutLabel(Date.now())}`);
  // The volume actually in force, read the same way every order reads it.
  if (accountId) {
    const setting = await prisma.xauusdM1M5VolumeSetting.findUnique({ where: { accountId } });
    const volume = resolveVolume(setting ? Number(setting.volumeLots) : null);
    log(`  volume        : ${volume.lots} lot (${volume.source})`);
  }
  if (process.env.XAUUSD_M1M5_VOLUME_LOTS?.trim()) {
    // It looks like it should work, which is exactly why it is a trap.
    log(
      '  WARNING: XAUUSD_M1M5_VOLUME_LOTS is set, but NOTHING reads it and it has no effect. ' +
        'Set the volume with: bash deploy/m1m5.sh set-volume <lots>',
    );
  }
  if (mode !== 'DEMO') {
    log('  Execution is not DEMO: decisions are observed and recorded, and no order is ever queued.');
  }

  let state = await loadOrWarmState(prisma, accountId);
  let lockSet: LockSet = createLockSet(SPEC_HASH);

  /**
   * Turns "this position has no stop loss" into a repair the collector will
   * act on, and tells the operator either way.
   *
   * An unprotected gold position is the most expensive state this application
   * can be in, and it is one that looks entirely normal from the fill
   * confirmation alone -- so it is announced loudly rather than left in a log
   * line nobody is watching.
   */
  const queueProtectionRemediation = async (issues: readonly ProtectionIssue[]): Promise<void> => {
    if (!accountId || issues.length === 0) return;
    const queued = await protection.requestAll(accountId, issues);
    if (queued > 0) {
      void telegram.notify(
        'PROTECTION_MISSING',
        `m1m5-protect:${issues.map((i) => i.ticket).join(',')}`,
        [
          `[${XAUUSD_M1M5_STRATEGY_VERSION} | ${messageCtx.accountLabel}] PROTECTION MISSING`,
          ...issues.map((i) => `${i.timeframe} ticket ${i.ticket}: ${i.missing} -- ${i.detail}`),
          `${queued} remediation request(s) queued. A broker accepting one is not proof the levels stuck; ` +
            'the next reconciliation pass re-reads the position and will queue another if it has not.',
        ].join('\n'),
        'OPS',
      );
    }
  };

  // --- Recovery, before the first cycle.
  //
  // `recoveryComplete` was previously set unconditionally at startup, which
  // made the gate that depends on it meaningless: it read true whether or not
  // anything had been reconciled. It now reflects a reconciliation pass that
  // actually ran, so until the broker's state has been read and compared
  // against ours, no entry is permitted -- which is the whole point of §10's
  // requirement and the difference between a gate and a decoration.
  state = { ...state, recoveryCompleteAtMs: null };
  if (accountId) {
    try {
      const snapshot = await buildBrokerSnapshot(prisma, accountId, Date.now());
      if (!snapshot.complete) {
        log('RECOVERY DEFERRED: the collector has not pushed recent broker state. No entry until it does.');
      } else {
        const outcome = await reconciliation.reconcile(accountId, snapshot);
        state = { ...state, recoveryCompleteAtMs: Date.now() };
        log(
          `Recovery complete: ${outcome.uncertainResolved} uncertain resolved, ` +
            `${outcome.closuresApplied} closures applied, ${outcome.locksActivated.length} lock(s) activated, ` +
            `${outcome.foreignPositionsSeen} foreign position(s) seen and left alone.`,
        );
        for (const issue of outcome.protectionIssues) {
          log(`PROTECTION ISSUE on ${issue.timeframe} ticket ${issue.ticket}: ${issue.missing} -- ${issue.detail}`);
        }
        await queueProtectionRemediation(outcome.protectionIssues);
      }
    } catch (err) {
      // Deliberately not fatal, and deliberately not "recovered". The loop
      // keeps observing and keeps refusing to enter, and the next cycle
      // retries -- a failed recovery must not become a silent permission.
      log(`Recovery FAILED (${(err as Error).message}). Observation continues; no entry until it succeeds.`);
    }
  } else {
    log('No account configured: nothing to reconcile, and nothing can be entered.');
  }
  let stopping = false;
  let consecutiveErrors = 0;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received. Saving state and stopping.`);
    try {
      writeWatchState(state);
    } catch (err) {
      log(`Failed to save state on shutdown: ${(err as Error).message}`);
    }
    await prisma.$disconnect();
    log('Stopped. Nothing is now observing RSI, and the Friday liquidation will not run.');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  let previousCycleAt: number | null = null;
  // Zero, not `Date.now()`: the first cycle should reconcile rather than wait
  // out an interval it has not earned.
  let lastReconciledAt = 0;

  const tick = async () => {
    if (stopping) return;
    const startedAt = Date.now();

    try {
      const candidates = await readQuoteCandidates(prisma);

      // Occupancy comes from the database, where the slot row IS the truth.
      const slots = accountId
        ? await occupancy.snapshot(accountId)
        : ({ M1: null, M5: null } as Record<Timeframe, null>);

      // --- Reconciliation: the startup retry, and then forever after.
      //
      // Running this only at startup would have been a serious gap. It is the
      // ONLY thing that resolves an UNKNOWN order, applies a broker-confirmed
      // closure, activates the post-loss lock that closure causes, and notices
      // a position whose stop loss the broker did not keep. Without a periodic
      // pass, an order that came back UNKNOWN at 09:00 holds its timeframe for
      // the rest of the day, a losing trade never arms its lock, and an
      // unprotected position stays unprotected -- all of it silently, with the
      // loop otherwise looking perfectly healthy.
      //
      // While recovery has not yet succeeded the entry gate stays shut, so the
      // retry is also the only way back to trading after a collector outage at
      // startup. Both cases are the same call at different cadences.
      const recovering = state.recoveryCompleteAtMs === null;
      const reconcileDue = recovering || startedAt - lastReconciledAt >= RECONCILE_INTERVAL_MS;
      if (accountId && reconcileDue) {
        const snapshot = await buildBrokerSnapshot(prisma, accountId, startedAt);
        if (snapshot.complete) {
          const outcome = await reconciliation.reconcile(accountId, snapshot);
          lastReconciledAt = startedAt;
          if (recovering) {
            state = { ...state, recoveryCompleteAtMs: Date.now() };
            log(
              `Recovery complete on retry: ${outcome.uncertainResolved} uncertain resolved, ` +
                `${outcome.closuresApplied} closures applied.`,
            );
          } else if (outcome.uncertainResolved > 0 || outcome.closuresApplied > 0 || outcome.locksActivated.length > 0) {
            log(
              `Reconciled: ${outcome.uncertainResolved} uncertain resolved, ` +
                `${outcome.closuresApplied} closures applied, ${outcome.locksActivated.length} lock(s) activated.`,
            );
          }
          await queueProtectionRemediation(outcome.protectionIssues);
        } else if (!recovering) {
          // Not an error: the collector may simply be between pushes. Worth
          // saying once it has gone on long enough to mean something.
          if (startedAt - lastReconciledAt >= RECONCILE_STALE_WARN_MS) {
            log(
              `Reconciliation has not run for ${Math.round((startedAt - lastReconciledAt) / 1000)}s: ` +
                'the collector has not pushed recent broker state. Closures and UNKNOWN orders are not being resolved.',
            );
            lastReconciledAt = startedAt; // rate-limits the warning itself
          }
        }
      }

      // --- Friday liquidation.
      //
      // Runs BEFORE the observation cycle, and runs regardless of execution
      // mode: §9.3 requires owned exposure to be flat before the weekend, and
      // a position that is already open does not stop needing to be closed
      // because entries are switched off. The service itself decides whether a
      // pass is due; calling it every cycle is what makes a missed timer
      // impossible rather than merely unlikely.
      if (liquidation) {
        const run = await liquidation.runOnce(startedAt);
        if (run.attempted.length > 0 || run.escalated.length > 0) {
          log(`LIQUIDATION ${run.verdict.status}: ${run.detail}`);
          for (const excluded of run.excluded) {
            log(`  left alone: ticket ${excluded.ticket} -- ${excluded.reason}`);
          }
        }
        // Both keyed per Beirut day, so an unchanging state is announced once
        // per liquidation window rather than every second until it changes.
        if (run.verdict.status === 'CONFIRMED_FLAT' && run.attempted.length > 0) {
          void telegram.notify(
            'LIQUIDATION_COMPLETE',
            `m1m5-liq-ok:${beirutDateKey(startedAt)}`,
            liquidationCompleteMessage(messageCtx, { closedCount: run.attempted.length }),
          );
        } else if (run.verdict.status === 'DEADLINE_MISSED') {
          // The one genuinely critical liquidation state: the deadline passed
          // and owned exposure is still open, or could not be read at all.
          void telegram.notify(
            'LIQUIDATION_FAILED',
            `m1m5-liq-fail:${beirutDateKey(startedAt)}`,
            liquidationFailedMessage(messageCtx, {
              remaining: run.verdict.remainingOwned,
              detail: run.detail,
            }),
            'OPS',
          );
        }
      }

      // What the terminal last reported about itself. Null when the collector
      // has never spoken, and null blocks -- an unheard-from terminal is not
      // evidence of an open market (section 9.4).
      const mt5 = accountId ? await snapshots.latest(accountId) : null;

      // Freshness measured from the newest quote we actually have, rather than
      // asserted. A cycle running against a quote older than the staleness
      // bound is observing history, and section 9 will not enter on it.
      const newestTickAtMs = candidates.reduce((newest, c) => Math.max(newest, c.tickAtMs), 0);
      const dataFresh =
        newestTickAtMs > 0 && (startedAt - newestTickAtMs) / 1000 <= V2_QUOTE_MAX_STALENESS_SECONDS;

      const gates = {
        // Reported by the collector from the live terminal. Null means "not
        // confirmed", which blocks exactly as false does: section 9.4 requires
        // the weekend reopening to be confirmed, never assumed from a clock.
        brokerSessionOpen: mt5?.sessionOpen ?? null,
        dataFresh,
        recoveryComplete: state.recoveryCompleteAtMs !== null,
        killSwitchEngaged: killSwitchState().active,
        executionBlockers: [] as string[],
      };

      const result = runCycle({
        candidates,
        evaluatedAtMs: startedAt,
        engines: state.engines,
        lockSet,
        occupancy: {
          M1: slots.M1
            ? { occupied: true, detail: `${slots.M1.state} since ${slots.M1.claimedAt.toISOString()}` }
            : { occupied: false, detail: 'no exposure' },
          M5: slots.M5
            ? { occupied: true, detail: `${slots.M5.state} since ${slots.M5.claimedAt.toISOString()}` }
            : { occupied: false, detail: 'no exposure' },
        },
        gates,
      });

      // State advances ONLY on the success path, and only from the result --
      // never partially from a cycle that threw halfway through.
      const engines = { ...state.engines };
      const crossings = { ...state.crossings };
      for (const outcome of result.outcomes) {
        engines[outcome.timeframe] = outcome.engine;
        crossings[outcome.timeframe] = outcome.engine.crossing;
      }
      lockSet = result.lockSet;

      state = {
        ...state,
        lastCycleAtMs: startedAt,
        lastCycleIntervalMs: previousCycleAt === null ? null : startedAt - previousCycleAt,
        engines,
        crossings,
        observationLimitations: result.limitations,
      };
      previousCycleAt = startedAt;
      writeWatchState(state);

      // --- Submission.
      //
      // Every candidate reaching here has already passed the strategy's own
      // rules: the crossing, the post-loss locks, occupancy and the schedule.
      // What follows is the execution service's deterministic gates -- risk,
      // brackets, MT5 permissions and the pre-send recheck -- and nothing
      // else. There is no approval step here, and no hook for one: section 8
      // forbids a human, an AI, Telegram or the dashboard from approving a
      // trade, so the only possible answers are the gates' answers.
      //
      // A submission failure never stops the loop and never advances state as
      // though it had succeeded; the outcome is recorded and observation
      // continues.
      if (result.candidates.length > 0) {
        const blocked = entriesBlockedByControls();
        const eligibility = evaluateEntryEligibility(startedAt, gates);

        for (const { timeframe, decision } of result.candidates) {
          const signal = decision.candidate;
          if (!signal) continue;
          const detail = `${timeframe} CANDIDATE ${signal.direction} at RSI ${signal.rsi}`;

          if (blocked) {
            log(`${detail} -- ${blocked}`);
            continue;
          }
          if (!accountId) {
            log(`${detail} -- no account configured; observation only, nothing queued.`);
            continue;
          }
          if (!result.quote) {
            log(`${detail} -- no usable quote at submission time; nothing queued.`);
            continue;
          }

          const built = await buildExecutionContext({
            prisma,
            accountId,
            signal,
            nowMs: startedAt,
            quote: { bid: result.quote.bid, ask: result.quote.ask, tickAtMs: result.quote.tickAtMs },
            snapshot: mt5,
            expectedLoginId,
            scheduleAllowsEntries: eligibility.eligible,
            scheduleDetail: eligibility.detail,
          });
          // Reported even when the gates would have refused anyway, because
          // "refused on risk" and "refused because nobody told us the leverage"
          // send an operator to entirely different places.
          if (built.gaps.blocking.length > 0) {
            log(`${detail} -- incomplete inputs: ${built.gaps.blocking.join('; ')}`);
          }

          const outcome = await execution.execute(built.context);
          log(`${detail} -- ${outcome.outcome}: ${outcome.detail}`);

          // Fire-and-forget, after the fact. §13 wants the operator told what
          // happened; §8 forbids them approving it, and there is nothing here
          // to approve -- the order is already queued by the time this runs.
          if (outcome.outcome === 'QUEUED') {
            state = { ...state, lastSubmissionLatencyMs: Date.now() - startedAt };
            // Read back from the row rather than reconstructed here. The
            // brackets were computed inside the execution service against the
            // same quote it priced the order with, and quoting a second,
            // separately derived set of levels in the message would make any
            // disagreement between them invisible in exactly the place an
            // operator would look to check.
            const queuedRow = outcome.decisionId
              ? await prisma.xauusdM1M5Decision.findUnique({ where: { id: outcome.decisionId } })
              : null;
            if (queuedRow?.entryPrice && queuedRow.stopLoss && queuedRow.takeProfit) {
              void telegram.notify(
                'ORDER_SUBMITTED',
                `m1m5-submit:${outcome.decisionId}`,
                submittedMessage(messageCtx, {
                  timeframe,
                  direction: signal.direction,
                  volumeLots: queuedRow.volumeLots ? Number(queuedRow.volumeLots) : 0,
                  requestedPrice: Number(queuedRow.entryPrice),
                  stopLoss: Number(queuedRow.stopLoss),
                  takeProfit: Number(queuedRow.takeProfit),
                }),
              );
            }
          } else if (outcome.decisionId) {
            // A refusal is as much a part of the record as a fill. Sent to OPS
            // rather than the trading channel: it is a reason nothing was
            // traded, not a trade.
            void telegram.notify(
              'SIGNAL_SKIPPED',
              `m1m5-skip:${outcome.decisionId}`,
              skippedMessage(messageCtx, {
                timeframe,
                direction: signal.direction,
                reason: outcome.outcome,
                detail: outcome.detail,
              }),
              'OPS',
            );
          }
        }
      }

      for (const outcome of result.outcomes) {
        for (const { direction, evidence } of outcome.decision?.unlocks ?? []) {
          log(
            `Post-loss lock RELEASED for ${direction} on ${evidence.condition} ${evidence.threshold} at RSI ${evidence.rsi}.`,
          );
          // Stated explicitly because it is the single most misread event in
          // this strategy: an unlock is NOT an entry, and never becomes one.
          void telegram.notify(
            'LOCK_RELEASED',
            `m1m5-unlock:${outcome.timeframe}:${direction}:${evidence.rsi}:${startedAt}`,
            lockReleasedMessage(messageCtx, {
              timeframe: outcome.timeframe,
              direction,
              rsi: evidence.rsi,
              condition: evidence.condition,
              threshold: evidence.threshold,
            }),
          );
        }
      }

      // --- The 24h performance report, and the Telegram retry sweep.
      //
      // Both are called every cycle and both decide for themselves whether
      // there is anything to do. The report refuses a period it has already
      // generated; the sweep only picks up rows whose backoff has elapsed.
      // Calling them unconditionally is what makes a missed timer impossible.
      try {
        if (accountId) {
          const report = await reporting.runOnce(accountId, messageCtx.accountLabel, startedAt);
          if (report.generated) {
            log(`Performance report generated and ${report.delivered ? 'delivered' : 'NOT delivered'}: ${report.detail}`);
          }
        }
        await telegram.retryPending(startedAt);
      } catch (err) {
        log(`Reporting/notification sweep failed (non-fatal): ${(err as Error).message}`);
      }

      if (consecutiveErrors > 0) {
        log(`Recovered after ${consecutiveErrors} consecutive error(s).`);
        consecutiveErrors = 0;
      }
      if (startedAt % 60_000 < cycleMs) log(describeCycle(result));
    } catch (err) {
      // Logged, counted, and followed by the next cycle. The loop must keep
      // observing through recoverable errors (section 14).
      consecutiveErrors += 1;
      log(`Cycle error (${consecutiveErrors} consecutive): ${(err as Error).message}`);
    } finally {
      if (!stopping) {
        // Scheduled from when this cycle FINISHED, so a slow cycle delays the
        // next rather than queueing behind it and drifting silently.
        const elapsed = Date.now() - startedAt;
        setTimeout(() => void tick(), Math.max(0, cycleMs - elapsed));
      }
    }
  };

  void tick();
}

main().catch((err) => {
  console.error('Fatal error starting the observation loop:', err);
  process.exit(1);
});
