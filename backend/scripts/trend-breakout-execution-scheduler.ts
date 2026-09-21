/**
 * Long-running process: periodically invokes
 * `TrendBreakoutCoordinatorService.evaluateAll()` for BOTH instruments
 * (EURUSD and XAUUSD — they go live together per the confirmed rollout
 * decision). Usage: `npm run trend-breakout-execution:scheduler` (reads
 * `TREND_BREAKOUT_EXECUTION_MODE`, `TREND_BREAKOUT_STOP_NEW_ENTRIES`,
 * `TREND_BREAKOUT_SCHEDULER_INTERVAL_SECONDS` [default 60] from the
 * environment). Ctrl+C / SIGTERM stops cleanly and releases the
 * single-instance lock.
 *
 * Simpler than `gold-execution-scheduler.ts` on purpose: trend-breakout
 * works off completed H4/H1 candles, not intra-candle touch events —
 * repeated evaluation of the same closed candle is already a safe no-op via
 * `TrendBreakoutCoordinatorService`'s own signal-identity uniqueness
 * constraint (`TrendBreakoutDecision`'s `[accountId, strategyVersion,
 * instrument, signalCloseAt]`) and hold-reuse logic in `logHold`. This
 * script therefore just calls `evaluateAll` on a fixed interval and lets the
 * coordinator's own idempotency handle the rest — no separate touch-event
 * store like gold's `GoldWatchStore` is needed.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { HistoricalCandleService } from '../src/market-data/historical-candle.service';
import { TrendBreakoutVolumeSettingsService } from '../src/trend-breakout/volume-settings.service';
import { SymbolMetadataService } from '../src/trend-breakout/symbol-metadata.service';
import { TrendBreakoutSlotLockService } from '../src/trend-breakout/slot-lock.service';
import { TrendBreakoutRiskStateService } from '../src/trend-breakout/risk-state.service';
import { TrendBreakoutRiskPolicySettingsService } from '../src/trend-breakout/risk-policy-settings.service';
import { TrendBreakoutDecisionLoggerService } from '../src/trend-breakout/trend-breakout-decision-logger.service';
import { TrendBreakoutCoordinatorService } from '../src/trend-breakout/trend-breakout-coordinator.service';
import { ProcessLock } from '../src/research/confirmed-retest/watch';

interface SchedulerCycleResult {
  outcomes: { instrument: string; action: string; decisionId: string }[];
}

/**
 * Minimal interval-loop runner, deliberately not importing
 * `GoldExecutionScheduler` (that class is gold-specific only by name, not
 * by any actual coupling, but keeping a fully separate instance here avoids
 * any future temptation to add gold-specific behavior to a shared class).
 * Same shape: `start()`/`stop()`, single-instance `ProcessLock`, calls
 * `runCycle` on a fixed interval, never overlaps two cycles.
 */
class TrendBreakoutExecutionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly opts: {
      intervalMs: number;
      lock: ProcessLock;
      runCycle: () => Promise<SchedulerCycleResult>;
      onCycleResult: (result: SchedulerCycleResult) => void;
      onCycleError: (err: unknown) => void;
    },
  ) {}

  start(): void {
    this.opts.lock.acquire(Date.now());
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const result = await this.opts.runCycle();
      this.opts.onCycleResult(result);
    } catch (err) {
      this.opts.onCycleError(err);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.opts.lock.release();
  }
}

async function main() {
  const prisma = new PrismaClient();
  const account = await prisma.tradingAccount.findFirst({ where: { platform: 'MT5' }, orderBy: { createdAt: 'asc' } });
  if (!account) {
    console.error('trend-breakout-execution-scheduler: no MT5 trading account found — exiting');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  // A bare ConfigService reads directly from process.env when no NestJS
  // application context loads a .env file into it explicitly — sufficient
  // here since this script runs from the same process environment (env_file
  // in docker-compose.prod.yml, or a locally exported shell env) that every
  // other module in this codebase already reads safety-relevant switches
  // from directly via `process.env`.
  const config = new ConfigService();
  const candles = new HistoricalCandleService(prisma as any);
  const volumeSettings = new TrendBreakoutVolumeSettingsService(prisma as any);
  const symbolMetadata = new SymbolMetadataService(prisma as any);
  const slotLock = new TrendBreakoutSlotLockService(prisma as any);
  const riskState = new TrendBreakoutRiskStateService(prisma as any);
  const riskPolicySettings = new TrendBreakoutRiskPolicySettingsService(prisma as any);
  const decisionLogger = new TrendBreakoutDecisionLoggerService(prisma as any);
  const coordinator = new TrendBreakoutCoordinatorService(
    prisma as any, candles, volumeSettings, symbolMetadata, slotLock, riskState, riskPolicySettings, decisionLogger, config,
  );

  const stateDir = process.env.TREND_BREAKOUT_SCHEDULER_STATE_DIR ?? resolve(__dirname, '..', 'research-state', 'trend-breakout-execution-scheduler');
  // Unlike gold's scheduler, nothing else here constructs a store whose own
  // constructor creates this directory as a side effect — ProcessLock itself
  // does not create its parent directory, so it must be created explicitly.
  mkdirSync(stateDir, { recursive: true });
  const lock = new ProcessLock(resolve(stateDir, 'trend-breakout-scheduler.process.lock'));
  const intervalSeconds = Number(process.env.TREND_BREAKOUT_SCHEDULER_INTERVAL_SECONDS ?? '60');
  const intervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : 60_000;

  console.log(`trend-breakout-execution-scheduler: starting, account=${account.id}, intervalMs=${intervalMs}, startedAt=${new Date().toISOString()}`);

  const scheduler = new TrendBreakoutExecutionScheduler({
    intervalMs,
    lock,
    runCycle: async () => {
      const outcomes = await coordinator.evaluateAll(account.id, new Date());
      return { outcomes: outcomes.map((o) => ({ instrument: o.instrument, action: o.action, decisionId: o.decisionId })) };
    },
    onCycleResult: (result) => {
      console.log(`trend-breakout-execution-scheduler: cycle complete at ${new Date().toISOString()}, outcomes=${JSON.stringify(result.outcomes)}`);
    },
    onCycleError: (err) => {
      console.error(`trend-breakout-execution-scheduler: cycle failed (will retry next interval): ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  scheduler.start();

  const shutdown = async (signal: string) => {
    console.log(`trend-breakout-execution-scheduler: received ${signal}, stopping...`);
    scheduler.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('trend-breakout-execution-scheduler: fatal error at startup:', err);
  process.exitCode = 1;
});
