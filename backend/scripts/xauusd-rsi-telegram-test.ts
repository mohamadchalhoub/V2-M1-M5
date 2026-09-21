/**
 * Verifies the gold/RSI Telegram audience and sends ONE clearly labelled test
 * notification to each configured recipient.
 *
 * Usage:
 *   npm run xauusd-rsi:telegram-test            verify only, send nothing
 *   npm run xauusd-rsi:telegram-test -- --send  verify, then send
 *
 * Deliberate properties:
 *
 * - It creates no trade, position, signal or protection incident. The message
 *   goes out through a dedicated test event type, and its audit record is
 *   labelled as a delivery test so it can never be mistaken for a real one.
 * - Every destination is verified through Telegram's own `getChat` BEFORE
 *   anything is sent, so a chat the bot cannot address produces a specific,
 *   actionable error rather than a silently swallowed notification.
 * - The message reports the ACTUAL current execution state. It never
 *   describes the system as active or healthy on the strength of having been
 *   able to send a message.
 * - Delivery is recorded per recipient, so one failing does not hide another
 *   succeeding, and a re-run re-sends only what has not already gone.
 */
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { GoldTelegramService } from '../src/gold-execution/gold-telegram.service';
import { RsiAccountStateService } from '../src/xauusd-rsi/account-state.service';
import { RsiRuntimeSettingsService } from '../src/xauusd-rsi/runtime-settings.service';
import { getRsiExecutionMode, killSwitchState, stopNewEntriesState } from '../src/xauusd-rsi/controls';
import { SPEC, SPEC_HASH } from '../src/xauusd-rsi/spec';
import { beirutLabel } from '../src/xauusd-rsi/time';
import { evaluateEntryEligibility } from '../src/xauusd-rsi/schedule';
import { defaultStateDir } from '../src/xauusd-rsi/state-store';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEND = process.argv.includes('--send');

async function main() {
  const prisma = new PrismaClient();
  const config = new ConfigService();
  const telegram = new GoldTelegramService(prisma as never, config);
  const accountState = new RsiAccountStateService(prisma as never);
  const runtimeSettings = new RsiRuntimeSettingsService();

  console.log('='.repeat(78));
  console.log('XAUUSD RSI — Telegram audience verification' + (SEND ? ' and test send' : ' (verify only)'));
  console.log('='.repeat(78));

  // --- 1. The bot itself ---------------------------------------------------
  const bot = await telegram.verifyBot();
  console.log(`\n[1] Bot: ${bot.ok ? 'OK' : 'FAILED'} — ${bot.detail}`);
  if (!bot.ok) {
    console.error('\nCannot continue without a working bot token. Nothing was sent.');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  // --- 2. The audience -----------------------------------------------------
  const { recipients, problems } = telegram.resolveRecipients();
  console.log(`\n[2] Configured recipients: ${recipients.length}`);
  for (const problem of problems) console.log(`    CONFIG PROBLEM: ${problem}`);
  if (recipients.length === 0) {
    console.error('\nNo valid recipient configured. Set GOLD_TELEGRAM_CHAT_ID and/or GOLD_TELEGRAM_CHAT_IDS.');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const verified: Array<{ recipient: (typeof recipients)[number]; ok: boolean; detail: string }> = [];
  for (const recipient of recipients) {
    const result = await telegram.verifyRecipient(recipient);
    verified.push({ recipient, ...result });
    console.log(`    ${result.ok ? 'OK     ' : 'FAILED '} ${recipient.label} (chat ${recipient.chatId}, from ${recipient.source}) — ${result.detail}`);
    if (!result.ok) {
      console.log('           ACTION: the person must open this bot in Telegram and press Start.');
      console.log('           A bot cannot message someone who has never started a conversation with it.');
    }
  }

  // --- 3. Actual current state, for the message body -----------------------
  const accountId = process.env.AUTONOMOUS_TRADING_ACCOUNT_ID?.trim() || null;
  const mode = getRsiExecutionMode();
  const kill = killSwitchState();
  const stop = stopNewEntriesState();
  const volume = runtimeSettings.resolveVolume();

  let riskInfo = null;
  let slots = null;
  let session: { open: boolean | null; detail: string } = { open: null, detail: 'no account configured' };
  if (accountId) {
    riskInfo = await accountState.resolveAccountRiskInfo(accountId);
    slots = await accountState.resolveSlotStates(accountId);
    session = await accountState.resolveBrokerSessionOpen();
  }

  const watch = readWatchState();

  const eligibility = evaluateEntryEligibility({
    utcMs: Date.now(),
    brokerSessionOpen: session.open,
    dataFresh: session.open === true,
    // Read from the watch process's own persisted state rather than assumed.
    // Hardcoding `false` here made an earlier run report the block as
    // RECOVERY_INCOMPLETE when the real blocker was the kill switch.
    recoveryComplete: watch.recoveryComplete,
    otherBlock: kill.active ? `kill switch active (${kill.source})` : stop.active ? `stop-new-entries active (${stop.source})` : mode === 'OFF' ? 'execution mode OFF' : null,
  });

  const executionState = [
    `mode ${mode}`,
    kill.active ? 'KILL SWITCH ENGAGED' : 'kill switch off',
    stop.active ? 'entries stopped' : 'entries not stopped',
    watch.running ? 'watch process running' : 'watch process NOT running',
    watch.recoveryComplete ? 'recovery complete' : 'recovery incomplete',
    eligibility.entriesAllowed ? 'eligible for entries' : `entries blocked (${eligibility.blockReason})`,
  ].join('; ');

  const text = [
    'TEST — XAUUSD RSI system notification.',
    'This is a delivery test, not a trading signal or broker order.',
    `Configured strategy: ${SPEC.strategyVersion} (spec ${SPEC_HASH}).`,
    `Extreme SELL: ${SPEC.thresholds.extremeSellCross}; extreme BUY: ${SPEC.thresholds.extremeBuyCross}.`,
    `Retest thresholds: SELL peak >${SPEC.thresholds.sell2} invalidating <${SPEC.thresholds.sell1}; BUY trough <${SPEC.thresholds.buy2} invalidating >${SPEC.thresholds.buy1}.`,
    `Configured volume: ${volume.volumeLots} lot per order. TP/SL: $${SPEC.brackets.takeProfitUsd}/$${SPEC.brackets.stopLossUsd} of gold price.`,
    'Two independent rule-family slots: RETEST and EXTREME.',
    slots
      ? `Slots now: RETEST ${slots.RETEST.occupied ? 'held' : 'free'}, EXTREME ${slots.EXTREME.occupied ? 'held' : 'free'}.`
      : 'Slots now: unknown (no trading account configured).',
    `Account: ${riskInfo ? `${riskInfo.tradeMode}, margin mode ${riskInfo.marginMode}` : 'not resolved'}.`,
    'XAUUSD observation target: every 1 second.',
    `Execution state: ${executionState}.`,
    `Time: ${new Date().toISOString()} (${beirutLabel(Date.now())}).`,
  ].join('\n');

  console.log('\n[3] Message to be sent:\n');
  console.log(text.split('\n').map((l) => `    ${l}`).join('\n'));

  if (!SEND) {
    console.log('\nVerify-only run — nothing was sent. Re-run with --send to deliver it.');
    await prisma.$disconnect();
    return;
  }

  // --- 4. Send -------------------------------------------------------------
  // A dedicated event type, so the audit record is unmistakably a delivery
  // test and never resembles a trading notification.
  const dedupKey = `rsi-delivery-test:${Date.now()}`;
  const report = await telegram.notify('DELIVERY_TEST', dedupKey, text);

  console.log('\n[4] Delivery results (per recipient):');
  let anyFailed = false;
  for (const result of report.results) {
    if (result.status === 'FAILED') anyFailed = true;
    console.log(
      `    ${result.status.padEnd(12)} ${result.recipient.label} (chat ${result.recipient.chatId})` +
        (result.messageId !== null ? ` message_id=${result.messageId}` : '') +
        (result.error ? ` error=${result.error}` : ''),
    );
  }
  console.log('\n    API acceptance confirms Telegram accepted the message for delivery.');
  console.log('    It does NOT confirm the person has read it.');

  const rows = await prisma.goldTelegramNotification.findMany({
    where: { dedupKey: { startsWith: dedupKey } },
    select: { dedupKey: true, chatId: true, recipientLabel: true, status: true, messageId: true, lastError: true },
  });
  console.log('\n[5] Persisted delivery records:');
  for (const row of rows) {
    console.log(`    chat=${row.chatId} label=${row.recipientLabel} status=${row.status} message_id=${row.messageId ?? 'n/a'}${row.lastError ? ` error=${row.lastError}` : ''}`);
  }

  await prisma.$disconnect();
  if (anyFailed) process.exitCode = 1;
}

/**
 * The standalone watch process's own reported state.
 *
 * Read rather than assumed: this message states the execution state, and a
 * guessed value would make it wrong in exactly the situation where an
 * operator most needs it to be right.
 */
function readWatchState(): { running: boolean; recoveryComplete: boolean } {
  const statePath = join(defaultStateDir(), 'xauusd-rsi-watch-state.json');
  if (!existsSync(statePath)) return { running: false, recoveryComplete: false };
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      recovery?: { lastCycleAtUtc?: string | null; recoveryComplete?: boolean };
    };
    const last = state.recovery?.lastCycleAtUtc;
    const running = last ? Date.now() - new Date(last).getTime() < 300_000 : false;
    return { running, recoveryComplete: state.recovery?.recoveryComplete === true };
  } catch {
    return { running: false, recoveryComplete: false };
  }
}

void main();
