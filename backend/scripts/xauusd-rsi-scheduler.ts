/**
 * The manually started watch process for
 * `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Usage: `npm run xauusd-rsi:scheduler`
 *
 * Reads from the environment:
 *   XAUUSD_RSI_EXECUTION_MODE        OFF (default) | SHADOW | DEMO
 *   XAUUSD_RSI_SCHEDULER_INTERVAL_SECONDS  default 5
 *   XAUUSD_RSI_STATE_DIR             default <backend>/xauusd-rsi-runtime
 *   AUTONOMOUS_TRADING_ACCOUNT_ID    the one DEMO account to trade
 *
 * This process is started BY HAND and nothing installs it as a service, a
 * scheduled task or a reboot autostart — that is a deliberate requirement,
 * and it has a consequence the operator must understand: while this process
 * is not running, nothing observes RSI and nothing performs the Friday
 * liquidation. See RECOVERY.md.
 *
 * Ctrl+C / SIGTERM stops cleanly, saves state and releases the lock.
 *
 * The interval defaults to 5 seconds rather than the previous strategy's 60:
 * this is an intrabar M1 strategy whose signals are only valid for about a
 * minute, so a one-minute cycle would routinely discover its own signals too
 * late to act on them. Each cycle drains whatever ticks arrived since the
 * last one, so a shorter interval means lower latency, not more work.
 */
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { RsiAccountStateService } from '../src/xauusd-rsi/account-state.service';
import { RsiCoordinatorService } from '../src/xauusd-rsi/coordinator.service';
import { RsiLiquidationService } from '../src/xauusd-rsi/liquidation.service';
import { RsiRuntimeSettingsService } from '../src/xauusd-rsi/runtime-settings.service';
import { RsiWatchService } from '../src/xauusd-rsi/watch.service';
import { RsiDecisionService } from '../src/xauusd-rsi/decision.service';
import { defaultStateDir, RsiWatchState, RsiWatchStore, SpecHashMismatchError } from '../src/xauusd-rsi/state-store';
import { getRsiExecutionMode, killSwitchState, stopNewEntriesState } from '../src/xauusd-rsi/controls';
import { SPEC, SPEC_HASH } from '../src/xauusd-rsi/spec';
import { beirutLabel } from '../src/xauusd-rsi/time';
import { RSI_OBSERVATION_INTERVAL_MS } from '../src/xauusd-rsi/safety-constants';
import { GoldTelegramService } from '../src/gold-execution/gold-telegram.service';
import { ConfigService } from '@nestjs/config';

async function main() {
  const prisma = new PrismaClient();

  const accountId = process.env.AUTONOMOUS_TRADING_ACCOUNT_ID?.trim();
  const account = accountId
    ? await prisma.tradingAccount.findUnique({ where: { id: accountId } })
    : await prisma.tradingAccount.findFirst({ where: { platform: 'MT5' }, orderBy: { createdAt: 'asc' } });

  if (!account) {
    console.error('xauusd-rsi-scheduler: no trading account found — exiting without starting.');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const stateDir = process.env.XAUUSD_RSI_STATE_DIR?.trim() || defaultStateDir();
  const store = new RsiWatchStore(stateDir);

  const accountState = new RsiAccountStateService(prisma as any);
  const runtimeSettings = new RsiRuntimeSettingsService();
  const coordinator = new RsiCoordinatorService(prisma as any, runtimeSettings, accountState);
  const liquidation = new RsiLiquidationService(prisma as any, accountState);
  // The gold Telegram channel is reused as-is (its own bot/chat, its own
  // durable dedup). A ConfigService is constructed directly here because this
  // process is standalone and deliberately does not boot the Nest container.
  const telegram = new GoldTelegramService(prisma as any, new ConfigService());
  const decisions = new RsiDecisionService(prisma as any, accountState);
  const watch = new RsiWatchService(prisma as any, coordinator, accountState, liquidation, decisions, telegram);

  // One second by default: the strategy must EVALUATE at the observation
  // cadence, not merely receive observations at it. An operator may raise this
  // but the default is the specified target.
  const intervalSeconds = Number(process.env.XAUUSD_RSI_SCHEDULER_INTERVAL_SECONDS ?? '1');
  const intervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : RSI_OBSERVATION_INTERVAL_MS;

  let state: RsiWatchState;
  try {
    state = store.load(SPEC.strategyVersion, 'TICK');
  } catch (err) {
    if (err instanceof SpecHashMismatchError) {
      // Refusing here is the point: reusing state written under different
      // thresholds would produce decisions no audit could explain.
      console.error(`xauusd-rsi-scheduler: ${err.message}`);
    } else {
      console.error(`xauusd-rsi-scheduler: could not load state — ${err instanceof Error ? err.message : err}`);
    }
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  try {
    store.acquireLock(Date.now());
  } catch (err) {
    console.error(`xauusd-rsi-scheduler: ${err instanceof Error ? err.message : err}`);
    console.error('Refusing to start a second watch process — two would both claim decisions and could both submit.');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const mode = getRsiExecutionMode();
  const kill = killSwitchState();
  const stop = stopNewEntriesState();
  const volume = runtimeSettings.resolveVolume();

  console.log('─'.repeat(78));
  console.log(`xauusd-rsi-scheduler starting at ${beirutLabel(Date.now())}`);
  console.log(`  strategy       ${SPEC.strategyVersion}  (spec ${SPEC_HASH})`);
  console.log(`  account        ${account.id}  (${account.externalAccountId})`);
  console.log(`  mode           ${mode}${mode === 'OFF' ? '  — observing and recording only; no orders will be queued' : ''}`);
  console.log(`  kill switch    ${kill.active ? `ACTIVE — ${kill.source}` : 'inactive'}`);
  console.log(`  stop entries   ${stop.active ? `ACTIVE — ${stop.source}` : 'inactive'}`);
  console.log(`  volume         ${volume.volumeLots} lots (${volume.source}: ${volume.sourceDetail})`);
  console.log(`  brackets       TP $${SPEC.brackets.takeProfitUsd} / SL $${SPEC.brackets.stopLossUsd} of gold price`);
  console.log(`  state dir      ${stateDir}`);
  console.log(`  interval       ${intervalMs}ms`);
  console.log('  NOTE: this process is manual-only. Nothing restarts it automatically, and');
  console.log('        nothing (including Friday liquidation) happens while it is stopped.');
  console.log('─'.repeat(78));

  let running = false;
  let stopped = false;

  const runOnce = async () => {
    if (stopped || running) return; // never overlap two cycles
    running = true;
    try {
      store.heartbeat(Date.now());
      const { result, state: nextState } = await watch.runCycle({ accountId: account.id, store, state });
      state = nextState;
      store.save(state);

      // Only report what actually happened; a quiet cycle stays quiet.
      if (result.ticksConsumed > 0 || result.signalsEmitted.length > 0 || result.reseeded) {
        console.log(
          `[${new Date().toISOString()}] ticks=${result.ticksConsumed} rsi=${result.currentRsi?.toFixed(2) ?? 'n/a'} ` +
            `warm=${result.warmedUp} signals=${result.signalsEmitted.length} ` +
            `slots=[RETEST:${result.slots.RETEST.occupied ? 'held' : 'free'} EXTREME:${result.slots.EXTREME.occupied ? 'held' : 'free'}] ` +
            `cadence=${result.cadence.measuredMs ?? 'n/a'}ms entries=${result.entriesAllowed ? 'allowed' : `blocked(${result.entryBlockReason})`}`,
        );
      }
      for (const decision of result.decisions) {
        console.log(`  decision ${decision.decisionId}: ${decision.queued ? 'QUEUED for the broker' : `skipped — ${decision.skipReason}`}`);
      }
      if (result.liquidation.phase !== 'NOT_DUE') {
        console.log(`  Friday liquidation: ${result.liquidation.phase} — ${result.liquidation.detail}`);
        for (const item of result.liquidation.outstanding) {
          console.log(`    outstanding ${item.kind} ${item.ticket} status=${item.status} attempts=${item.attempts}`);
        }
      }
      if (result.liquidation.criticalIncident) {
        console.error(`  CRITICAL: ${result.liquidation.criticalIncident}`);
      }
    } catch (err) {
      // A single bad cycle never kills the loop — the next one tries again.
      console.error(`[${new Date().toISOString()}] cycle failed: ${err instanceof Error ? err.stack ?? err.message : err}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, intervalMs);
  void runOnce();

  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    console.log(`\nxauusd-rsi-scheduler: ${signal} received — saving state and releasing the lock.`);
    try {
      store.save(state);
    } catch (err) {
      console.error(`  failed to save state on shutdown: ${err instanceof Error ? err.message : err}`);
    }
    store.releaseLock();
    await prisma.$disconnect();
    console.log('xauusd-rsi-scheduler: stopped. Nothing is observing RSI or performing Friday liquidation now.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
