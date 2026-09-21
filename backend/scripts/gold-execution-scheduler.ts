/**
 * Long-running process: periodically invokes the gold watch cycle.
 * Usage: `npm run gold-execution:scheduler` (reads GOLD_EXECUTION_MODE,
 * GOLD_STOP_NEW_ENTRIES, GOLD_SCHEDULER_INTERVAL_SECONDS [default 60] from
 * the environment). Ctrl+C / SIGTERM stops cleanly and releases the
 * single-instance lock.
 */
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { GoldAccountStateService } from '../src/gold-execution/gold-account-state.service';
import { GoldExecutionCoordinatorService } from '../src/gold-execution/gold-execution-coordinator.service';
import { GoldRuntimeSettingsService } from '../src/gold-execution/gold-runtime-settings.service';
import { GoldExecutionScheduler } from '../src/gold-execution/gold-execution-scheduler';
import { GOLD_MAX_ENTRY_DEVIATION_POINTS, GOLD_POINT_SIZE, GOLD_SYMBOL } from '../src/gold-execution/gold-safety-constants';
import { GoldWatchStore, runGoldWatchCycle } from '../src/gold-execution/gold-signal-source';
import { ProcessLock } from '../src/research/confirmed-retest/watch';

async function main() {
  const prisma = new PrismaClient();
  const account = await prisma.tradingAccount.findFirst({ where: { platform: 'MT5' }, orderBy: { createdAt: 'asc' } });
  if (!account) {
    console.error('gold-execution-scheduler: no MT5 trading account found — exiting');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const accountState = new GoldAccountStateService(prisma as any);
  const coordinator = new GoldExecutionCoordinatorService(prisma as any, new GoldRuntimeSettingsService());
  const stateDir = process.env.GOLD_RESEARCH_STATE_DIR ?? resolve(__dirname, '..', 'research-state', 'gold-live-watch');
  const store = new GoldWatchStore(stateDir);
  const lock = new ProcessLock(resolve(stateDir, 'gold-scheduler.process.lock'));
  const intervalSeconds = Number(process.env.GOLD_SCHEDULER_INTERVAL_SECONDS ?? '60');
  const intervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : 60_000;

  console.log(`gold-execution-scheduler: starting, account=${account.id}, intervalMs=${intervalMs}, startedAt=${new Date().toISOString()}`);

  const scheduler = new GoldExecutionScheduler({
    intervalMs,
    lock,
    runCycle: async () => {
      const result = await runGoldWatchCycle({
        prisma, coordinator, store, nowT: Date.now(), accountId: account.id,
        buildContext: async () => ({
          accountInfo: await accountState.resolveAccountRiskInfo(account.id),
          occupancy: await accountState.resolveOccupancy(account.id),
          volumeConstraints: await accountState.resolveVolumeConstraints(),
          maxEntryDeviationPoints: GOLD_MAX_ENTRY_DEVIATION_POINTS,
          goldPointSize: GOLD_POINT_SIZE,
        }),
        getExecutablePrice: async (direction) => {
          const tick = await prisma.liveTick.findUnique({ where: { symbol: GOLD_SYMBOL } });
          if (!tick) return null;
          return direction === 'BUY' ? tick.ask.toNumber() : tick.bid.toNumber();
        },
        getLiveQuote: async () => {
          const tick = await prisma.liveTick.findUnique({ where: { symbol: GOLD_SYMBOL } });
          if (!tick) return null;
          return { bid: tick.bid.toNumber(), atT: tick.tickAt.getTime() };
        },
      });
      return {
        actionableEventCount: result.actionableEvents.length,
        liveTouchEventCount: result.liveTouchEvents.length,
        liveTouchQueuedCount: result.liveTouchResults.filter((r) => r.coordinatorResult.queuedDecisionId !== null).length,
      };
    },
    onCycleResult: (result) => {
      console.log(`gold-execution-scheduler: cycle complete at ${new Date().toISOString()}, actionableEvents=${result.actionableEventCount}, liveTouchEvents=${result.liveTouchEventCount}, liveTouchQueued=${result.liveTouchQueuedCount}`);
    },
    onCycleError: (err) => {
      console.error(`gold-execution-scheduler: cycle failed (will retry next interval): ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  scheduler.start();

  const shutdown = async (signal: string) => {
    console.log(`gold-execution-scheduler: received ${signal}, stopping...`);
    scheduler.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('gold-execution-scheduler: fatal error at startup:', err);
  process.exitCode = 1;
});
