/**
 * Engine B's ingestion process.
 *
 * A separate, manually started long-lived process — the same shape as Engine
 * A's observation loop, and for the same reason: booting the API must not be
 * able to start copying trades, and the thing that holds a Telegram user
 * session should be one process rather than every container that imports a
 * module.
 *
 * It does three things, and nothing else:
 *
 *   1. connects to Telegram and processes updates as they arrive;
 *   2. sweeps price frequently so the TP1 touch latch is real rather than
 *      evaluated only when a leg happens to be considered;
 *   3. reports liveness on a slow heartbeat.
 *
 * Note what is NOT here: reconciliation and order placement. Those belong to
 * the collector, which is the process that can actually see the terminal.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { TelegramEngineModule } from '../src/telegram-engine/telegram-engine.module';
import { TelegramIngestionService } from '../src/telegram-engine/ingestion/ingestion.service';
import { TelegramTp1WatchService, TP1_WATCH_WINDOW_MS } from '../src/telegram-engine/tp1-watch.service';
import { TelegramEntryRetraceWatchService } from '../src/telegram-engine/entry-retrace-watch.service';
import { DailyReportService } from '../src/telegram-engine/daily-report.service';
import { getTelegramExecutionMode, telegramEngineEnabled } from '../src/telegram-engine/controls';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelegramEngineNotificationService } from '../src/telegram-engine/notifications/notification.service';

/**
 * How often price is sampled for the TP1 latch.
 *
 * Fast, because the thing being detected is a touch that can last a single
 * tick, and missing it means opening a leg into a trade that is already over.
 * Cheap enough to justify: one quote read plus an indexed query over signals
 * from the last few minutes.
 */
const TP1_SWEEP_INTERVAL_MS = 1_000;
/**
 * How often a signal awaiting its entry retrace is re-checked. Slightly
 * slower than the TP1 sweep on purpose: this sweep can place a real order and
 * touches the account snapshot, quote and margin, not just a boolean latch.
 */
const ENTRY_RETRACE_SWEEP_INTERVAL_MS = 2_000;
/** The daily report goes out on the first check after midnight Beirut time. */
const DAILY_REPORT_CHECK_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
/** Slow: a retry storm against a revoked token helps nobody. */
const ALERT_RETRY_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const logger = new Logger('telegram-ingest');

  // The deployed environment file already names both of these, for Engine A.
  // Engine B reads the SAME values rather than requiring the operator to
  // duplicate them under new names: two variables holding one account id is a
  // pair that will eventually disagree, and the failure that follows — an
  // engine trading the right account while verifying the wrong one — is
  // exactly what the identity check exists to prevent.
  //
  // A Telegram-specific override is honoured first, for the case where Engine
  // B is deliberately pointed elsewhere, but nothing has to be set for the
  // ordinary deployment to work.
  const accountId = (
    process.env.TELEGRAM_ENGINE_ACCOUNT_ID ??
    process.env.XAUUSD_M1M5_ACCOUNT_ID ??
    process.env.COLLECTOR_ACCOUNT_ID ??
    ''
  ).trim();
  if (!accountId) {
    logger.error(
      'No account id is configured. Set XAUUSD_M1M5_ACCOUNT_ID (the deployment already does) or ' +
        'TELEGRAM_ENGINE_ACCOUNT_ID. Refusing to start: ingestion must know which account it is for.',
    );
    process.exit(1);
  }
  // Same reasoning. Without this, readiness would block every signal with
  // ACCOUNT_IDENTITY_UNKNOWN while the terminal was in fact logged into the
  // right account — a failure that looks like a broker problem and is not.
  const expectedLoginId =
    (process.env.XAUUSD_M1M5_EXPECTED_LOGIN_ID ?? process.env.XAUUSD_M1M5_EXPECTED_LOGIN ?? '').trim() || null;
  if (expectedLoginId === null) {
    logger.warn(
      'No expected MT5 login is configured, so the terminal account cannot be verified and every Telegram signal ' +
        'will be refused as ACCOUNT_IDENTITY_UNKNOWN. Set XAUUSD_M1M5_EXPECTED_LOGIN.',
    );
  }

  // Only Engine B's module, NOT the whole AppModule.
  //
  // Booting AppModule here would make this process require the OUTBOUND
  // notification bot's configuration - a different Telegram credential, for a
  // different purpose, belonging to Engine A's alerting - before it could
  // receive a single message. That is both unnecessary coupling and a wider
  // blast radius for the one container that holds the user session: it would
  // construct every controller, every strategy service and every scheduler
  // provider in the application.
  const app = await NestFactory.createApplicationContext(TelegramEngineModule, {
    logger: ['error', 'warn', 'log'],
  });
  const ingestion = app.get(TelegramIngestionService);
  const tp1 = app.get(TelegramTp1WatchService);
  const entryRetrace = app.get(TelegramEntryRetraceWatchService);
  const dailyReport = app.get(DailyReportService);
  const prisma = app.get(PrismaService);
  const notifier = app.get(TelegramEngineNotificationService);

  logger.log(
    `Engine B ingestion starting. mode=${getTelegramExecutionMode()} enabled=${telegramEngineEnabled()} ` +
      `account=${accountId}`,
  );
  if (!telegramEngineEnabled() || getTelegramExecutionMode() !== 'DEMO') {
    // Said plainly at startup so nobody watching the log concludes from
    // "connected" that trades are being placed.
    logger.warn(
      'Engine B is NOT in a state where a leg can reach the broker. Messages will be received, parsed, recorded ' +
        'and evaluated, and every gate will run, but nothing will be queued. This is SHADOW.',
    );
  }

  await ingestion.start(accountId, expectedLoginId);

  const sweep = setInterval(() => {
    void tp1.sweep(accountId, Date.now()).catch((err) => {
      // A failed sweep latches nothing, which leaves existing latches intact.
      // That is the safe direction, so it is a warning rather than a stop.
      logger.warn(`TP1 sweep failed: ${(err as Error).message}`);
    });
  }, TP1_SWEEP_INTERVAL_MS);

  const entryRetraceSweep = setInterval(() => {
    void entryRetrace.sweep(accountId, Date.now(), expectedLoginId).catch((err) => {
      // A failed sweep leaves every waiting signal exactly as it was, so
      // nothing is lost — the next tick tries again.
      logger.warn(`entry-retrace sweep failed: ${(err as Error).message}`);
    });
  }, ENTRY_RETRACE_SWEEP_INTERVAL_MS);

  const dailyReportCheck = setInterval(() => {
    void dailyReport.runOnce(accountId, Date.now());
  }, DAILY_REPORT_CHECK_INTERVAL_MS);

  // Retries alerts that failed to send earlier. Without this, one transient
  // network blip permanently loses a trade alert -- the row would sit FAILED
  // and nothing would ever look at it again.
  const alertRetry = setInterval(() => {
    void notifier.retryPending().catch((err) => {
      logger.warn(`alert retry failed: ${(err as Error).message}`);
    });
  }, ALERT_RETRY_INTERVAL_MS);

  const heartbeat = setInterval(() => {
    const health = ingestion.health();
    logger.log(
      `ingestion heartbeat: connected=${health.telegramConnected} ` +
        `lastUpdate=${health.lastUpdateAt ?? 'none'} lastPoll=${health.lastPollAt ?? 'none'} ` +
        `lastSourceMessage=${health.lastSourceMessageAt ?? 'none'} ` +
        `latencyMs=${health.ingestionLatencyMs ?? 'n/a'} tp1WatchWindowMs=${TP1_WATCH_WINDOW_MS}`,
    );
    // `lastUpdate` is the PUSH path only (see gramjs-client.ts). If it never
    // advances while `lastPoll` keeps ticking every few seconds, push
    // delivery has stalled exactly as it did on 2026-09-23 -- the poll
    // fallback is still finding messages, so nothing is lost, but this is
    // worth a loud line so it does not go unnoticed a second time.
    if (health.lastPollError) {
      logger.warn(`poll fallback is failing: ${health.lastPollError}`);
    }
    // Persists this same snapshot so the api process — a separate container,
    // with no access to this process's memory — can show it on the
    // dashboard. Riding the existing heartbeat cadence rather than a new
    // timer of its own.
    void ingestion.persistHealthSnapshot(accountId).catch((err) => {
      logger.warn(`could not persist ingestion health snapshot: ${(err as Error).message}`);
    });
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received; stopping ingestion.`);
    clearInterval(sweep);
    clearInterval(entryRetraceSweep);
    clearInterval(dailyReportCheck);
    clearInterval(heartbeat);
    clearInterval(alertRetry);
    await ingestion.stop();
    await prisma.$disconnect().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Loud and fatal. An ingestion process that stays up while unable to
  // receive messages is worse than one that exits and gets restarted, because
  // a quiet channel and a broken connection look identical from outside.
  // eslint-disable-next-line no-console
  console.error(`telegram ingestion failed to start: ${(err as Error).message}`);
  process.exit(1);
});
