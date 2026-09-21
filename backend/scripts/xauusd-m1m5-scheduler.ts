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
import { createEngineState, warmUpFromClosedBars } from '../src/xauusd-m1m5/engine';
import { createCrossingState } from '../src/xauusd-m1m5/crossing';
import { createLockSet, type LockSet } from '../src/xauusd-m1m5/locks';
import { M1M5OccupancyService } from '../src/xauusd-m1m5/occupancy.service';
import type { QuoteCandidate } from '../src/xauusd-m1m5/quote';
import { describeCycle, runCycle } from '../src/xauusd-m1m5/watch-cycle';
import { defaultStateDir, readWatchState, writeWatchState, type WatchState } from '../src/xauusd-m1m5/state-store';
import { SPEC, SPEC_HASH, TIMEFRAMES, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from '../src/xauusd-m1m5/spec';
import { beirutLabel } from '../src/xauusd-m1m5/time';
import { assertMagicNumbersAreDisjoint } from '../src/xauusd-m1m5/ownership';
import { V2_OBSERVATION_INTERVAL_MS } from '../src/xauusd-m1m5/safety-constants';

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

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
    return existing;
  }
  log('No usable persisted state (absent, corrupt, or written under different rules). Warming from history.');

  const engines = { M1: createEngineState('M1'), M5: createEngineState('M5') };
  const needed = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;

  for (const tf of TIMEFRAMES) {
    const bars = await prisma.historicalCandle.findMany({
      where: { symbol: SPEC.symbol, timeframe: tf },
      orderBy: { openTime: 'desc' },
      take: needed,
      select: { close: true },
    });
    const closes = bars.reverse().map((b) => Number(b.close));
    engines[tf] = warmUpFromClosedBars(engines[tf], closes);
    log(`${tf}: warmed from ${closes.length} closed bars (${needed} needed before any signal may form).`);
  }

  return {
    strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
    specHash: SPEC_HASH,
    accountId,
    lastCycleAtMs: Date.now(),
    lastCycleIntervalMs: null,
    lastSubmissionLatencyMs: null,
    engines,
    crossings: { M1: createCrossingState('M1', SPEC_HASH), M5: createCrossingState('M5', SPEC_HASH) },
    observationLimitations: [],
    recoveryCompleteAtMs: Date.now(),
  };
}

/** The two quote streams, normalised into candidates for coherent selection. */
async function readQuoteCandidates(prisma: PrismaClient): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];

  const live = await prisma.liveTick.findFirst({ where: { symbol: SPEC.symbol } });
  if (live) {
    candidates.push({
      bid: Number(live.bid),
      ask: Number(live.ask),
      // Already true UTC on the way in; normalised exactly once, upstream.
      tickAtMs: live.tickAt.getTime(),
      source: 'live_ticks',
    });
  }

  const historical = await prisma.historicalTick.findFirst({
    where: { symbol: SPEC.symbol },
    orderBy: { timestamp: 'desc' },
  });
  if (historical && historical.bid !== null && historical.ask !== null) {
    candidates.push({
      bid: Number(historical.bid),
      ask: Number(historical.ask),
      tickAtMs: historical.timestamp.getTime(),
      source: 'historical_ticks',
    });
  }

  return candidates;
}

async function main() {
  // Refuses to start on a magic-number collision rather than trading into one.
  assertMagicNumbersAreDisjoint();

  const prisma = new PrismaClient();
  const occupancy = new M1M5OccupancyService(prisma);
  const accountId = process.env.XAUUSD_M1M5_ACCOUNT_ID?.trim() || null;
  const mode = getM1M5ExecutionMode();
  const cycleMs = intervalMs();

  log(`${XAUUSD_M1M5_STRATEGY_VERSION} observation loop starting.`);
  log(`  spec hash     : ${SPEC_HASH}`);
  log(`  execution mode: ${mode}`);
  log(`  interval      : ${cycleMs}ms`);
  log(`  account       : ${accountId ?? 'NOT CONFIGURED - observation only'}`);
  log(`  Beirut now    : ${beirutLabel(Date.now())}`);
  if (mode !== 'DEMO') {
    log('  Execution is not DEMO: decisions are observed and recorded, and no order is ever queued.');
  }

  let state = await loadOrWarmState(prisma, accountId);
  let lockSet: LockSet = createLockSet(SPEC_HASH);
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

  const tick = async () => {
    if (stopping) return;
    const startedAt = Date.now();

    try {
      const candidates = await readQuoteCandidates(prisma);

      // Occupancy comes from the database, where the slot row IS the truth.
      const slots = accountId
        ? await occupancy.snapshot(accountId)
        : ({ M1: null, M5: null } as Record<Timeframe, null>);

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
        gates: {
          // Session state is reported by the collector. Until that is wired,
          // null blocks, which is the correct and honest default (section 9.4)
          // and keeps execution off regardless of the configured mode.
          brokerSessionOpen: null,
          dataFresh: true,
          recoveryComplete: state.recoveryCompleteAtMs !== null,
          killSwitchEngaged: killSwitchState().active,
          executionBlockers: [],
        },
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

      if (result.candidates.length > 0) {
        const blocked = entriesBlockedByControls();
        for (const { timeframe, decision } of result.candidates) {
          log(
            `${timeframe} CANDIDATE ${decision.candidate?.direction} at RSI ${decision.candidate?.rsi} -- ` +
              (blocked ?? 'submission path not yet wired; nothing queued.'),
          );
        }
      }

      for (const { direction, evidence } of result.outcomes.flatMap((o) => o.decision?.unlocks ?? [])) {
        log(`Post-loss lock RELEASED for ${direction} on ${evidence.condition} ${evidence.threshold} at RSI ${evidence.rsi}.`);
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
