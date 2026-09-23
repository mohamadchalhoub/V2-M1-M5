/**
 * The activation alerts, sent through the existing notification bot.
 *
 *     node dist/scripts/telegram-announce.js pending
 *     node dist/scripts/telegram-announce.js active
 *     node dist/scripts/telegram-announce.js disabled "<reason>"
 *
 * ## Why `active` verifies before it speaks
 *
 * The post-activation alert says "Status: ACTIVE, MT5: READY, Reconciliation:
 * READY". If it sent that without checking, it would be an assertion nobody
 * verified — and the operator reading it would stop looking. So this reads
 * the same runtime facts `telegram-ready` does and REFUSES to send the
 * success alert when they do not hold, exiting non-zero instead.
 *
 * The `pending` alert has no such condition: it is a warning that something
 * is about to change, and it is true whether or not the change then succeeds.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { evaluateReadiness } from '../src/xauusd-m1m5/mt5-readiness';
import { M1M5Mt5SnapshotService } from '../src/xauusd-m1m5/mt5-snapshot.service';
import { TelegramEngineNotificationService } from '../src/telegram-engine/notifications/notification.service';
import {
  activationCompleteMessage,
  activationPendingMessage,
  engineDisabledMessage,
} from '../src/telegram-engine/notifications/messages';
import { getTelegramExecutionMode, telegramEngineEnabled } from '../src/telegram-engine/controls';
import { readStoredSession } from '../src/telegram-engine/ingestion/session-store';
import { displayChannelId, normaliseChannelId } from '../src/telegram-engine/ingestion/channel-guard';

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? '').trim().toLowerCase();
  if (!['pending', 'active', 'disabled'].includes(mode)) {
    console.error('usage: telegram-announce <pending|active|disabled> [reason]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const notifier = new TelegramEngineNotificationService(prisma);

  const accountId = (
    process.env.TELEGRAM_ENGINE_ACCOUNT_ID ??
    process.env.XAUUSD_M1M5_ACCOUNT_ID ??
    process.env.COLLECTOR_ACCOUNT_ID ??
    ''
  ).trim();
  const expectedLoginId =
    (process.env.XAUUSD_M1M5_EXPECTED_LOGIN_ID ?? process.env.XAUUSD_M1M5_EXPECTED_LOGIN ?? '').trim() || null;

  const session = readStoredSession();
  const channelId = (process.env.TELEGRAM_INGEST_SOURCE_CHANNEL_ID ?? '').trim() || session?.sourceChannelId || null;

  const snapshots = new M1M5Mt5SnapshotService(prisma);
  const snapshot = accountId ? await snapshots.latest(accountId) : null;
  const readiness = evaluateReadiness({
    snapshot: snapshot?.permissions ?? null,
    expectedLoginId,
    nowMs: Date.now(),
  });
  const recon = accountId
    ? await prisma.telegramReconciliationState.findUnique({ where: { accountId } })
    : null;
  // Liveness is judged by whether the channel has ever delivered to us, which
  // is the only evidence this process has of ingestion working.
  const lastIngested = await prisma.telegramIngestedMessage.findFirst({ orderBy: { receivedAt: 'desc' } });

  const facts = {
    sourceChannelId: channelId ? displayChannelId(normaliseChannelId(channelId)) : 'unresolved',
    accountMode: snapshot?.permissions.tradeMode ?? 'UNKNOWN',
    mt5Ready: readiness.ready,
    ingestionConnected: session !== null && channelId !== null,
    recoveryComplete: recon?.recoveryComplete === true,
  };

  if (mode === 'pending') {
    await notifier.notify(
      'ENGINE_B_ACTIVATING',
      `telegram:activating:${Date.now()}`,
      activationPendingMessage(facts),
      'TRADING',
    );
    console.log('Pre-activation alert sent.');
  } else if (mode === 'disabled') {
    const reason = (process.argv[3] ?? 'disabled by operator').trim();
    await notifier.notify(
      'ENGINE_B_DISABLED',
      `telegram:disabled:${Date.now()}`,
      engineDisabledMessage(reason),
      'TRADING',
    );
    console.log('Disable alert sent.');
  } else {
    // --- The success alert is a claim about the runtime, so it is checked.
    const problems: string[] = [];
    if (!telegramEngineEnabled()) problems.push('TELEGRAM_ENGINE_ENABLED is not true in this process');
    if (getTelegramExecutionMode() !== 'DEMO') problems.push(`execution mode is ${getTelegramExecutionMode()}, not DEMO`);
    if (!readiness.ready) problems.push(`MT5 not ready: ${readiness.blockers.map((b) => b.code).join(', ')}`);
    if (!facts.recoveryComplete) problems.push('reconciliation has not completed a recovery pass');
    if (!facts.ingestionConnected) problems.push('no Telegram session or unresolved source channel');

    if (problems.length > 0) {
      console.error('Refusing to send the ACTIVE alert. The runtime does not support that claim:');
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('');
      console.error('Fix these, then re-run. An alert saying ACTIVE when it is not is worse than no alert.');
      await prisma.$disconnect();
      process.exit(1);
    }

    await notifier.notify(
      'ENGINE_B_ACTIVE',
      `telegram:active:${Date.now()}`,
      activationCompleteMessage(facts),
      'TRADING',
    );
    console.log('Post-activation alert sent.');
    console.log(`Engine B became active at ${new Date().toISOString()}`);
    if (lastIngested) {
      console.log(`Last source message seen: ${lastIngested.receivedAt.toISOString()}`);
    } else {
      console.log('No source message has been received yet.');
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(`telegram-announce failed: ${(err as Error).message}`);
  process.exit(1);
});
