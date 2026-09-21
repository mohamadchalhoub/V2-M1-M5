/**
 * DIAGNOSTIC / STATUS message — NOT part of the rule-triggered alert
 * pipeline. Sends one human-readable "account update" snapshot straight to
 * Telegram via TelegramBotClient, for manually confirming during a live
 * MT5 integration test that real data is actually flowing end-to-end and
 * that Telegram delivery itself works — completely separate from
 * AlertLifecycleService/RuleEngineService, never creates an Alert row,
 * never affects rule cooldowns/state, and must never be scheduled to run
 * automatically (e.g. every 10s alongside snapshot ingestion) — that would
 * turn a diagnostic tool into unwanted alert-fatigue spam. Run it by hand,
 * only when you want a status check.
 *
 * Run: npm run send-account-summary -- <accountId> [chatId]
 *   chatId defaults to the first TELEGRAM_TRADING_CHAT_IDS entry.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { TelegramBotClient } from '../src/telegram/telegram-bot.client';

const prisma = new PrismaClient();

function fmtMoney(value: unknown): string {
  const n = Number(value ?? 0);
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPlain(value: unknown, unit = ''): string {
  return value === null || value === undefined ? 'n/a' : `${Number(value).toFixed(2)}${unit}`;
}

async function main(): Promise<void> {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('Usage: npm run send-account-summary -- <accountId> [chatId]');
    process.exitCode = 1;
    return;
  }

  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId } });
  if (!account) {
    console.error(`No trading account with id ${accountId}`);
    process.exitCode = 1;
    return;
  }

  const [snapshot, positions, heartbeat, ruleCount] = await Promise.all([
    prisma.accountSnapshot.findFirst({ where: { accountId }, orderBy: { capturedAt: 'desc' } }),
    prisma.position.findMany({ where: { accountId, status: 'OPEN' }, orderBy: { openedAt: 'desc' } }),
    prisma.collectorHeartbeat.findUnique({ where: { accountId } }),
    prisma.ruleDefinition.count({ where: { accountId, enabled: true } }),
  ]);

  const lines: string[] = [
    `Trading Monitor - Account Update (diagnostic)`,
    ``,
    `Account: ${account.displayName ?? account.externalAccountId}`,
    `Server: ${account.broker ?? 'n/a'}`,
    `Currency: ${account.currency}`,
    ``,
  ];

  if (snapshot) {
    lines.push(
      `Balance: ${fmtMoney(snapshot.balance)}`,
      `Equity: ${fmtMoney(snapshot.equity)}`,
      `Floating P/L: ${fmtMoney(snapshot.profit)}`,
      `Margin: ${fmtPlain(snapshot.margin)}`,
      `Free Margin: ${fmtPlain(snapshot.freeMargin)}`,
      `Margin Level: ${snapshot.marginLevel === null ? 'n/a' : fmtPlain(snapshot.marginLevel, '%')}`,
      ``,
    );
  } else {
    lines.push('No snapshot received yet.', '');
  }

  lines.push(`Open Positions: ${positions.length}`);
  if (positions.length > 0) {
    lines.push('', 'Positions:');
    for (const p of positions) {
      lines.push(
        `- ${p.symbol} ${p.side} ${Number(p.volume).toFixed(2)}`,
        `  Entry: ${p.openPrice}  Current: ${p.currentPrice ?? 'n/a'}`,
        `  P/L: ${fmtMoney(p.profit)}`,
        `  SL: ${p.stopLoss ?? 'none'}  TP: ${p.takeProfit ?? 'none'}`,
      );
    }
  }

  const heartbeatAge = heartbeat
    ? `${Math.round((Date.now() - heartbeat.lastHeartbeatAt.getTime()) / 1000)}s ago`
    : 'never';
  lines.push(
    '',
    'System:',
    `Collector: ${heartbeat?.mt5Connected ? 'Connected' : 'Not connected / no heartbeat'}`,
    `Last update: ${heartbeatAge}`,
    `Database: OK (this message was built from a live query)`,
    `Rules: ${ruleCount} enabled`,
    `Telegram: sending now`,
  );

  const message = lines.join('\n');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const tradingChatIds = (process.env.TELEGRAM_TRADING_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const chatId = process.argv[3] ?? tradingChatIds[0];
  if (!botToken || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or a chat id (set TELEGRAM_TRADING_CHAT_IDS or pass one explicitly).');
    console.log('\n--- Message that would have been sent ---\n');
    console.log(message);
    process.exitCode = 1;
    return;
  }

  const client = new TelegramBotClient({
    botToken,
    tradingChatIds,
    opsChatIds: [],
    reconciliationIntervalMs: 60_000,
    staleThresholdMs: 120_000,
  });
  const messageId = await client.sendMessage(chatId, message);
  console.log(`Sent diagnostic account summary to chat ${chatId} (Telegram message_id=${messageId}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
