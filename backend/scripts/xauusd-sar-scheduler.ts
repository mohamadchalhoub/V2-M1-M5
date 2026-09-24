/**
 * ENGINE A — the manually started process for `xauusd-sar-v1`, the $0.50
 * continuous trailing stop-and-reverse strategy that replaces the frozen
 * `xauusd-m1-m5-rsi-threshold-v2` (its scheduler, `xauusd-m1m5-scheduler.ts`,
 * is left in the repository but is no longer the one an operator runs for
 * Engine A).
 *
 * Usage: `npm run xauusd-sar:scheduler`
 *
 * Reads from the environment:
 *   XAUUSD_SAR_ENABLED            must be "true", or nothing evaluates
 *   XAUUSD_SAR_EXECUTION_MODE     OFF (default) | SHADOW | DEMO
 *   XAUUSD_SAR_ACCOUNT_ID         falls back to XAUUSD_M1M5_ACCOUNT_ID /
 *                                 COLLECTOR_ACCOUNT_ID, exactly as Engine B
 *                                 does, so one account id does not have to be
 *                                 duplicated under a third name
 *   XAUUSD_M1M5_EXPECTED_LOGIN_ID  same identity check Engine A/B already use
 *
 * WHILE THIS PROCESS IS NOT RUNNING: no session initializes, no direction is
 * discovered, no reversal executes, and no daily close happens. Engine B is
 * a completely separate process and is unaffected either way.
 *
 * Self-scheduling, not `setInterval`: each cycle is timed and the next one is
 * scheduled from when the previous finished, so drift is reported honestly
 * rather than silently queueing cycles behind each other. A cycle that throws
 * is logged and followed by the next cycle — it never stops the loop and
 * never advances state as though it had succeeded.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { XauusdSarModule } from '../src/xauusd-sar/xauusd-sar.module';
import { SarExecutionService } from '../src/xauusd-sar/execution.service';
import { SarReconciliationService } from '../src/xauusd-sar/reconciliation.service';
import { getSarExecutionMode, sarEngineEnabled } from '../src/xauusd-sar/controls';
import { SAR_OBSERVATION_INTERVAL_MS } from '../src/xauusd-sar/safety-constants';
import { isWithinDailyClose } from '../src/xauusd-sar/spec';
import { M1M5Mt5SnapshotService } from '../src/xauusd-m1m5/mt5-snapshot.service';
import { readQuoteCandidates } from '../src/xauusd-m1m5/quote-sources';
import { resolveQuote } from '../src/xauusd-m1m5/quote';
import { evaluateReadiness } from '../src/xauusd-m1m5/mt5-readiness';

const HEARTBEAT_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const logger = new Logger('xauusd-sar-scheduler');

  const accountId = (
    process.env.XAUUSD_SAR_ACCOUNT_ID ??
    process.env.XAUUSD_M1M5_ACCOUNT_ID ??
    process.env.COLLECTOR_ACCOUNT_ID ??
    ''
  ).trim();
  if (!accountId) {
    logger.error('No account id configured. Set XAUUSD_M1M5_ACCOUNT_ID (already set for Engine A/B) or XAUUSD_SAR_ACCOUNT_ID.');
    process.exit(1);
  }
  const expectedLoginId = (process.env.XAUUSD_M1M5_EXPECTED_LOGIN_ID ?? process.env.XAUUSD_M1M5_EXPECTED_LOGIN ?? '').trim() || null;

  const app = await NestFactory.createApplicationContext(XauusdSarModule, { logger: ['error', 'warn', 'log'] });
  const prisma = app.get(PrismaService);
  const execution = app.get(SarExecutionService);
  const reconciliation = app.get(SarReconciliationService);
  const snapshots = new M1M5Mt5SnapshotService(prisma as never);

  logger.log(`xauusd-sar starting. mode=${getSarExecutionMode()} enabled=${sarEngineEnabled()} account=${accountId}`);
  if (!sarEngineEnabled() || getSarExecutionMode() !== 'DEMO') {
    logger.warn('Engine A (SAR) is NOT in a state where an order can reach the broker. Evaluating and recording only (SHADOW-equivalent) or fully off.');
  }

  let running = true;
  let lastCloseDate: string | null = null;

  process.on('SIGTERM', () => (running = false));
  process.on('SIGINT', () => (running = false));

  const heartbeat = setInterval(() => {
    logger.log(`heartbeat: mode=${getSarExecutionMode()} enabled=${sarEngineEnabled()}`);
  }, HEARTBEAT_INTERVAL_MS);

  while (running) {
    const cycleStart = Date.now();
    try {
      await execution.ensureSession(accountId, cycleStart);

      const permissionSnapshot = await snapshots.latest(accountId);
      const candidates = await readQuoteCandidates(prisma as never);
      const resolved = resolveQuote(candidates, cycleStart);

      if (isWithinDailyClose(cycleStart)) {
        const today = new Date(cycleStart).toISOString().slice(0, 10);
        if (lastCloseDate !== today) {
          const result = await execution.closeForDay(accountId, cycleStart);
          logger.log(`daily close: ${result.action} — ${result.detail}`);
          if (result.action === 'DAILY_CLOSED') lastCloseDate = today;
        }
      } else {
        lastCloseDate = null;
        const readiness = evaluateReadiness({
          nowMs: cycleStart,
          snapshot: permissionSnapshot?.permissions ?? null,
          expectedLoginId,
        });

        if (resolved.quote && permissionSnapshot?.sessionOpen && readiness.ready) {
          const quoteInput = { bid: resolved.quote.bid, ask: resolved.quote.ask, ageSeconds: resolved.quote.ageSeconds, fresh: resolved.quote.fresh };
          const initResult = await execution.initializeSession(accountId, quoteInput, cycleStart);
          if (initResult.action !== 'NONE') logger.log(`init: ${initResult.action} — ${initResult.detail}`);
          const tickResult = await execution.evaluateTick(accountId, quoteInput, cycleStart);
          if (tickResult.action !== 'NONE') logger.log(`tick: ${tickResult.action} — ${tickResult.detail}`);
        }
      }

      // NOT YET WIRED: reconciliation needs a broker positions/deals snapshot,
      // which only the collector's process can read from MT5 directly. The
      // collector-side polling for xauusd_sar_order_attempts and the endpoint
      // that pushes a snapshot into SarReconciliationService.reconcile() are
      // listed as an open item in the final report — see PART LXIII #20.
      void reconciliation;
    } catch (err) {
      logger.error(`cycle failed (continuing): ${(err as Error).message}`);
    }

    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, SAR_OBSERVATION_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  clearInterval(heartbeat);
  await prisma.$disconnect().catch(() => undefined);
  await app.close();
  logger.log('xauusd-sar stopped.');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`xauusd-sar scheduler failed to start: ${(err as Error).message}`);
  process.exit(1);
});
