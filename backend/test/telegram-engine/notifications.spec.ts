/**
 * Engine B's alerts.
 *
 * The rule under test above all others: **every alert identifies itself as
 * Engine B.** Both engines send to the same chats about the same symbol on
 * one account, so an alert that does not say which engine produced it is an
 * alert an operator can act on wrongly at three in the morning.
 *
 * The first suite enumerates every exported message builder by reflection
 * rather than by a hand-written list, so a future alert that forgets the
 * header fails here instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import * as messages from '../../src/telegram-engine/notifications/messages';
import { engineBHeader } from '../../src/telegram-engine/notifications/messages';
import { readNotifyConfig, redact } from '../../src/telegram-engine/notifications/notification.service';
import { TELEGRAM_MAGIC } from '../../src/telegram-engine/safety-constants';

const SIGNAL = {
  messageId: '4421',
  direction: 'SELL' as const,
  entry: 4338,
  stopLoss: 4348,
  takeProfits: [4329, 4300],
  tp1: 4329,
  publishedAtIso: '2026-09-23T00:08:12.000Z',
  receivedAtIso: '2026-09-23T00:08:12.400Z',
  ingestionLatencyMs: 400,
  signalAgeMs: 1200,
};

const ACTIVATION = {
  sourceChannelId: '-1002014074104',
  accountMode: 'DEMO',
  mt5Ready: true,
  ingestionConnected: true,
  recoveryComplete: true,
};

/** Every exported builder, called with arguments it will accept. */
const EVERY_MESSAGE: Array<[string, string]> = [
  ['activationPendingMessage', messages.activationPendingMessage(ACTIVATION)],
  ['activationCompleteMessage', messages.activationCompleteMessage(ACTIVATION)],
  ['engineDisabledMessage', messages.engineDisabledMessage('operator request')],
  ['ingestionStateMessage(connected)', messages.ingestionStateMessage(true, 'reconnected after 12s')],
  ['ingestionStateMessage(disconnected)', messages.ingestionStateMessage(false, 'socket closed')],
  ['signalReceivedMessage', messages.signalReceivedMessage(SIGNAL)],
  [
    'tradeExecutedMessage',
    messages.tradeExecutedMessage({
      messageId: '4421',
      direction: 'SELL',
      sourceEntry: 4338,
      stopLoss: 4348,
      legs: [
        { legIndex: 1, legCount: 2, volumeLots: 0.01, takeProfit: 4329, fillPrice: 4337.9, ticket: '900001', status: 'FILLED' },
        { legIndex: 2, legCount: 2, volumeLots: 0.01, takeProfit: 4300, fillPrice: 4337.8, ticket: '900002', status: 'FILLED' },
      ],
      signalAgeAtExecutionMs: 3400,
      mode: 'DEMO',
    }),
  ],
  [
    'positionClosedMessage',
    messages.positionClosedMessage({
      messageId: '4421',
      legIndex: 1,
      legCount: 2,
      direction: 'SELL',
      volumeLots: 0.01,
      entryFill: 4337.9,
      exitPrice: 4329,
      stopLoss: 4348,
      takeProfit: 4329,
      realizedPl: 8.9,
      ticket: '900001',
    }),
  ],
  [
    'signalSkippedMessage',
    messages.signalSkippedMessage('TELEGRAM_TP1_ALREADY_REACHED', 'Price reached 4329.', {
      messageId: '4421',
      direction: 'SELL',
      entry: 4338,
    }),
  ],
  [
    'protectionIncidentMessage',
    messages.protectionIncidentMessage({ messageId: '4421', legIndex: 1, ticket: '900001', detail: 'No SL reported.' }),
  ],
  ['reconciliationIncidentMessage', messages.reconciliationIncidentMessage('Snapshot incomplete.')],
  [
    'uncertainExecutionMessage',
    messages.uncertainExecutionMessage({ messageId: '4421', legIndex: 2, detail: 'Response lost.' }),
  ],
];

describe('every alert identifies Engine B', () => {
  it.each(EVERY_MESSAGE)('%s carries the header', (_name, text) => {
    expect(text.startsWith(engineBHeader()) || text.includes(`${engineBHeader()}\n`)).toBe(true);
  });

  it.each(EVERY_MESSAGE)('%s names the source channel', (_name, text) => {
    expect(text).toContain('Source: @SFxauusd1');
  });

  it('the header is unmistakable against Engine A', () => {
    expect(engineBHeader()).toBe('ENGINE B — TELEGRAM CHANNEL');
    for (const [, text] of EVERY_MESSAGE) {
      // Nothing may describe itself as the RSI engine or as M1/M5.
      expect(text).not.toMatch(/\bM1\/M5\b|\bRSI\b/);
    }
  });

  it('covers every alert the specification enumerates', () => {
    // A reminder in test form: if an alert type is added to the engine, it
    // belongs in EVERY_MESSAGE too, or the header rule stops being enforced
    // for it.
    const exported = Object.keys(messages).filter((k) => k.endsWith('Message'));
    const covered = new Set(EVERY_MESSAGE.map(([name]) => name.replace(/\(.*\)$/, '')));
    for (const name of exported) {
      expect(covered.has(name), `${name} is exported but not covered by the header tests`).toBe(true);
    }
  });
});

describe('the signal alert', () => {
  const text = messages.signalReceivedMessage(SIGNAL);

  it('shows the side, entry and stop', () => {
    expect(text).toContain('Side: SELL');
    expect(text).toContain('Entry: 4338');
    expect(text).toContain('SL: 4348');
  });

  it('lists every take profit separately', () => {
    expect(text).toContain('TP1: 4329');
    expect(text).toContain('TP2: 4300');
  });

  it('states how many orders it will place, and at what size', () => {
    expect(text).toContain('Planned orders: 2');
    expect(text).toContain('Volume per order: 0.01');
  });

  it('reports the measured latency rather than an estimate', () => {
    expect(text).toContain('Ingestion latency: 400ms');
    expect(text).toContain('Signal age: 1.2s');
  });

  it('omits a latency it could not measure instead of printing undefined', () => {
    const withoutLatency = messages.signalReceivedMessage({ ...SIGNAL, ingestionLatencyMs: null, signalAgeMs: null });
    expect(withoutLatency).not.toMatch(/undefined|null|NaN/);
    expect(withoutLatency).not.toContain('Ingestion latency');
  });
});

describe('the execution alert', () => {
  const text = EVERY_MESSAGE.find(([n]) => n === 'tradeExecutedMessage')![1];

  it('shows each leg with its own ticket, so tickets are never hidden', () => {
    expect(text).toContain('LEG 1/2');
    expect(text).toContain('Ticket: 900001');
    expect(text).toContain('LEG 2/2');
    expect(text).toContain('Ticket: 900002');
  });

  it('shows each leg its own take profit', () => {
    expect(text).toContain('TP: 4329');
    expect(text).toContain('TP: 4300');
  });

  it('states the mode, so a DEMO trade is never mistaken for a live one', () => {
    expect(text).toContain('Mode: DEMO');
  });

  it('reports a leg with no fill by status rather than inventing a price', () => {
    const partial = messages.tradeExecutedMessage({
      messageId: '1',
      direction: 'SELL',
      sourceEntry: 4338,
      stopLoss: 4348,
      legs: [{ legIndex: 1, legCount: 1, volumeLots: 0.01, takeProfit: 4329, fillPrice: null, ticket: null, status: 'PENDING' }],
      signalAgeAtExecutionMs: null,
      mode: 'DEMO',
    });
    expect(partial).toContain('Status: PENDING');
    expect(partial).not.toMatch(/undefined|null|NaN/);
  });
});

describe('the closure alert uses broker truth', () => {
  it('reports a realised result the broker gave', () => {
    const text = EVERY_MESSAGE.find(([n]) => n === 'positionClosedMessage')![1];
    expect(text).toContain('Result: +$8.90');
    expect(text).toContain('Broker Ticket: 900001');
    expect(text).toContain('Leg: 1/2');
  });

  it('says so plainly when the broker gave no figure, instead of computing one', () => {
    const text = messages.positionClosedMessage({
      messageId: '1',
      legIndex: 1,
      legCount: 1,
      direction: 'SELL',
      volumeLots: 0.01,
      entryFill: 4338,
      exitPrice: null,
      stopLoss: 4348,
      takeProfit: 4329,
      realizedPl: null,
      ticket: '900001',
    });
    expect(text).toContain('not established from broker evidence');
    expect(text).not.toMatch(/\$NaN|undefined/);
  });

  it('marks a loss distinctly from a win', () => {
    const loss = messages.positionClosedMessage({
      messageId: '1', legIndex: 1, legCount: 1, direction: 'SELL', volumeLots: 0.01,
      entryFill: 4338, exitPrice: 4348, stopLoss: 4348, takeProfit: 4329, realizedPl: -10.4, ticket: '9',
    });
    expect(loss).toContain('Result: -$10.40');
  });
});

describe('the activation alerts', () => {
  it('state the facts the operator is authorising', () => {
    const text = messages.activationPendingMessage(ACTIVATION);
    expect(text).toContain('Account Mode: DEMO');
    expect(text).toContain(`Magic: ${TELEGRAM_MAGIC}`);
    expect(text).toContain('Volume: 0.01 lot per TP');
    expect(text).toContain('Maximum Signal Age: 60 seconds');
    expect(text).toContain('Engine A: UNCHANGED');
  });

  it('do not claim readiness that was not established', () => {
    const text = messages.activationCompleteMessage({ ...ACTIVATION, mt5Ready: false, recoveryComplete: false });
    expect(text).toContain('MT5: NOT READY');
    expect(text).toContain('Reconciliation: NOT READY');
  });
});

describe('credential handling in the sender', () => {
  it('redacts the bot token from anything stored or logged', () => {
    const token = '1234567890:AAExampleTokenValueForTesting';
    expect(redact(`failed: https://api.telegram.org/bot${token}/sendMessage`, token)).not.toContain(token);
    expect(redact(`failed: ${token}`, token)).toContain('<redacted-token>');
  });

  it('falls back to the existing bot configuration so no new secret is needed', () => {
    const config = readNotifyConfig({
      XAUUSD_M1M5_TELEGRAM_BOT_TOKEN: 'shared-token',
      XAUUSD_M1M5_TELEGRAM_TRADING_CHAT_IDS: 'Ops:-100123,-100456',
    } as NodeJS.ProcessEnv);
    expect(config.botToken).toBe('shared-token');
    expect(config.tradingChatIds).toEqual([
      { label: 'Ops', chatId: '-100123' },
      { label: null, chatId: '-100456' },
    ]);
  });

  it('prefers an Engine B-specific bot when one is configured', () => {
    const config = readNotifyConfig({
      XAUUSD_M1M5_TELEGRAM_BOT_TOKEN: 'shared-token',
      TELEGRAM_ENGINE_NOTIFY_BOT_TOKEN: 'engine-b-token',
    } as NodeJS.ProcessEnv);
    expect(config.botToken).toBe('engine-b-token');
  });

  it('reports no recipients rather than inventing one', () => {
    const config = readNotifyConfig({} as NodeJS.ProcessEnv);
    expect(config.botToken).toBeNull();
    expect(config.tradingChatIds).toEqual([]);
  });
});
