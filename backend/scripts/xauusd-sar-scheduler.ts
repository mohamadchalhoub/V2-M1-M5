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
import { getSarExecutionMode, sarEngineEnabled } from '../src/xauusd-sar/controls';
import { SAR_OBSERVATION_INTERVAL_MS } from '../src/xauusd-sar/safety-constants';
import { isWithinDailyClose } from '../src/xauusd-sar/spec';
import { checkFlattenIdentity, closeWindowAction, readFlattenRequired } from '../src/xauusd-sar/flatten-required';
import { SAR_MAGIC } from '../src/xauusd-sar/safety-constants';
import { M1M5Mt5SnapshotService } from '../src/xauusd-m1m5/mt5-snapshot.service';
import { readQuoteCandidates } from '../src/xauusd-m1m5/quote-sources';
import { resolveQuote } from '../src/xauusd-m1m5/quote';
import { evaluateReadiness } from '../src/xauusd-m1m5/mt5-readiness';

const HEARTBEAT_INTERVAL_MS = 60_000;
const GATE_LOG_INTERVAL_MS = 60_000;

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
  // MT5_EXPECTED_LOGIN is the name the collector, the dashboard and the M1M5
  // scheduler read; accepting only the older XAUUSD_M1M5_* names left SAR's
  // readiness permanently ACCOUNT_IDENTITY_UNKNOWN on a deployment that sets
  // just the current one, so initializeSession was never reached.
  const expectedLoginId =
    (
      process.env.XAUUSD_M1M5_EXPECTED_LOGIN_ID ??
      process.env.XAUUSD_M1M5_EXPECTED_LOGIN ??
      process.env.MT5_EXPECTED_LOGIN ??
      ''
    ).trim() || null;
  if (!expectedLoginId) {
    logger.warn('No expected MT5 login configured (MT5_EXPECTED_LOGIN). Readiness will block every SAR evaluation as ACCOUNT_IDENTITY_UNKNOWN.');
  }

  const app = await NestFactory.createApplicationContext(XauusdSarModule, { logger: ['error', 'warn', 'log'] });
  const prisma = app.get(PrismaService);
  const execution = app.get(SarExecutionService);
  const snapshots = new M1M5Mt5SnapshotService(prisma as never);

  logger.log(`xauusd-sar starting. mode=${getSarExecutionMode()} enabled=${sarEngineEnabled()} account=${accountId}`);
  if (!sarEngineEnabled() || getSarExecutionMode() !== 'DEMO') {
    logger.warn('Engine A (SAR) is NOT in a state where an order can reach the broker. Evaluating and recording only (SHADOW-equivalent) or fully off.');
  }

  let running = true;
  let lastCloseLogMs = 0;
  let lastGateReason = '';
  let lastGateLogMs = 0;

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

      const flattenMarker = readFlattenRequired();
      if (isWithinDailyClose(cycleStart) || flattenMarker !== null) {
        const session = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
        const readinessNow = evaluateReadiness({ nowMs: cycleStart, snapshot: permissionSnapshot?.permissions ?? null, expectedLoginId });
        const marketTradeable = resolved.quote?.fresh === true && permissionSnapshot?.sessionOpen === true && readinessNow.ready;
        let identityProblems: string[] = [];
        if (flattenMarker === 'UNREADABLE') {
          identityProblems = ['flatten-required marker is unreadable'];
        } else if (flattenMarker !== null) {
          const open = await prisma.position.findMany({ where: { accountId, symbol: 'XAUUSD', status: 'OPEN' } });
          const sar = open
            .map((p) => ({ ticket: p.externalPositionId, side: String(p.side), volume: Number(p.volume), magic: Number((p.rawPayload as { magic?: unknown } | null)?.magic ?? NaN), symbol: p.symbol }))
            .filter((p) => p.magic === SAR_MAGIC);
          identityProblems = checkFlattenIdentity(flattenMarker, sar, session?.brokerTicket ?? null);
        }
        const action = closeWindowAction({ sessionState: session?.state ?? null, marketTradeable, flattenRequired: flattenMarker !== null, identityProblems });
        if (action === 'FLATTEN') {
          const result = await execution.closeForDay(accountId, cycleStart);
          logger.log(`close: ${result.action} — ${result.detail}`);
        } else if (action !== 'NONE' && cycleStart - lastCloseLogMs >= GATE_LOG_INTERVAL_MS) {
          const why = action === 'IDENTITY_MISMATCH' ? identityProblems.join('; ') : 'market not tradeable (closed, stale quote or not ready); flatten stays required';
          (action === 'IDENTITY_MISMATCH' ? logger.error.bind(logger) : logger.warn.bind(logger))(`close pending, not submitting: ${action} — ${why}`);
          lastCloseLogMs = cycleStart;
        }
      } else {
        const readiness = evaluateReadiness({
          nowMs: cycleStart,
          snapshot: permissionSnapshot?.permissions ?? null,
          expectedLoginId,
        });

        const gateBlockers: string[] = [];
        if (!resolved.quote) gateBlockers.push('NO_QUOTE');
        else if (!resolved.quote.fresh) gateBlockers.push(`QUOTE_STALE(${resolved.quote.ageSeconds.toFixed(1)}s)`);
        if (!permissionSnapshot) gateBlockers.push('NO_PERMISSION_SNAPSHOT');
        else if (permissionSnapshot.sessionOpen !== true) gateBlockers.push(`SESSION_OPEN=${String(permissionSnapshot.sessionOpen)}`);
        if (!readiness.ready) gateBlockers.push(...readiness.blockers.map((b) => b.code));
        const gateReason = gateBlockers.join(',');
        if (gateBlockers.length > 0 && (gateReason !== lastGateReason || cycleStart - lastGateLogMs >= GATE_LOG_INTERVAL_MS)) {
          logger.warn(`evaluation gated, not evaluating this cycle: ${gateReason}`);
          lastGateLogMs = cycleStart;
        }
        if (gateBlockers.length === 0 && lastGateReason) logger.log('evaluation gate open again.');
        lastGateReason = gateReason;

        if (resolved.quote && permissionSnapshot?.sessionOpen && readiness.ready) {
          const quoteInput = { bid: resolved.quote.bid, ask: resolved.quote.ask, ageSeconds: resolved.quote.ageSeconds, fresh: resolved.quote.fresh };
          const initResult = await execution.initializeSession(accountId, quoteInput, cycleStart);
          if (initResult.action !== 'NONE') logger.log(`init: ${initResult.action} — ${initResult.detail}`);
          const tickResult = await execution.evaluateTick(accountId, quoteInput, cycleStart);
          if (tickResult.action !== 'NONE') logger.log(`tick: ${tickResult.action} — ${tickResult.detail}`);
        }
      }

      // Reconciliation itself runs OUTSIDE this loop: the collector pushes a
      // broker positions/deals snapshot straight to the main API's
      // POST .../xauusd-sar/reconcile endpoint (SarExecutionController ->
      // SarReconciliationService), on the same one-second cadence as its SAR
      // order poll. This scheduler only needs to keep evaluating ticks; it
      // has no MT5 access of its own to reconcile with.
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
