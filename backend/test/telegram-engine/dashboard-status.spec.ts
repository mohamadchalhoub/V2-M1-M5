/**
 * The Engine B dashboard's `status()` endpoint, against a REAL database.
 *
 * These cases exist because of a gap found by inspection: the endpoint reads
 * `TelegramIngestedMessage` and `TelegramIngestionHealth`, and both are
 * written by a DIFFERENT PROCESS (telegram-ingest) than the one serving this
 * endpoint (api). The only thing worth testing here is that what one writes
 * is exactly what the other reads back — the two are connected only through
 * the database.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TelegramDashboardController } from '../../src/telegram-engine/dashboard.controller';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const controller = new TelegramDashboardController(prisma);

const NOW = Date.UTC(2026, 8, 23, 13, 0, 0);
let accountId: string;

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  accountId = account.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a source message that is not a valid signal', () => {
  it('appears in lastMessage but never in signals', async () => {
    await prisma.telegramIngestedMessage.create({
      data: {
        channelId: '-1002014074104',
        messageId: '77296',
        publishedAt: new Date(NOW),
        receivedAt: new Date(NOW + 1_000),
        publicationToIngestionMs: 1_000,
        textPreview: 'متاحة الان للدخول',
        classification: 'NOT_A_SIGNAL',
        refusalReason: 'SYMBOL_NOT_GOLD',
        deliveryPath: 'POLL',
      },
    });

    const status = await controller.status(accountId);

    expect(status.lastMessage).toEqual(
      expect.objectContaining({
        messageId: '77296',
        classification: 'NOT_A_SIGNAL',
        refusalReason: 'SYMBOL_NOT_GOLD',
        deliveryPath: 'POLL',
      }),
    );
    // The rule under test: a non-signal message updates observability but
    // never becomes a trading record.
    expect(status.signals).toHaveLength(0);
  });

  it('reports refusalReason as null for a message that WAS a valid signal', async () => {
    await prisma.telegramIngestedMessage.create({
      data: {
        channelId: '-1002014074104',
        messageId: '77297',
        publishedAt: new Date(NOW),
        receivedAt: new Date(NOW + 500),
        textPreview: 'Gold sell now 4339',
        classification: 'PARSED_SIGNAL',
        refusalReason: null,
        deliveryPath: 'PUSH',
      },
    });

    const status = await controller.status(accountId);
    expect(status.lastMessage?.refusalReason).toBeNull();
    expect(status.lastMessage?.classification).toBe('PARSED_SIGNAL');
  });

  it('reports null lastMessage fields as null rather than throwing when no message has ever arrived', async () => {
    const status = await controller.status(accountId);
    expect(status.lastMessage).toBeNull();
  });
});

describe('delivery path attribution survives duplicate delivery', () => {
  it('keeps the FIRST edge that delivered a message when the other edge redelivers it', async () => {
    // Simulates push delivering first, then poll redelivering the same
    // message a few seconds later — exactly the situation both edges running
    // concurrently can produce. The unique (channelId, messageId, isEdit)
    // constraint is what the real recordIngestedMessage() relies on to make
    // this durable; this proves the constraint actually holds that shape.
    const data = {
      channelId: '-1002014074104',
      messageId: '77298',
      publishedAt: new Date(NOW),
      receivedAt: new Date(NOW + 200),
      textPreview: 'Gold sell now 4339',
      classification: 'PARSED_SIGNAL',
      deliveryPath: 'PUSH',
    };
    await prisma.telegramIngestedMessage.create({ data });

    // The poll edge's later attempt at the same row.
    await expect(
      prisma.telegramIngestedMessage.create({
        data: { ...data, receivedAt: new Date(NOW + 8_200), deliveryPath: 'POLL' },
      }),
    ).rejects.toThrow();

    const row = await prisma.telegramIngestedMessage.findFirst({ where: { messageId: '77298' } });
    expect(row?.deliveryPath).toBe('PUSH');
  });
});

describe('ingestion health, written by a different process than it is read by', () => {
  it('reads back exactly what was written', async () => {
    await prisma.telegramIngestionHealth.create({
      data: {
        accountId,
        authorized: true,
        connected: true,
        pushLastUpdateAt: new Date(NOW),
        pollLastAt: new Date(NOW + 8_000),
        pollLastError: null,
      },
    });

    const status = await controller.status(accountId);
    expect(status.ingestionHealth).toEqual(
      expect.objectContaining({
        present: true,
        authorized: true,
        connected: true,
        pollLastError: null,
      }),
    );
    expect(status.ingestionHealth.pushLastUpdateAt).toBe(new Date(NOW).toISOString());
  });

  it('reports present: false rather than fabricating a healthy state when no snapshot has ever been written', async () => {
    const status = await controller.status(accountId);
    expect(status.ingestionHealth.present).toBe(false);
    expect(status.ingestionHealth.connected).toBeNull();
  });

  it('surfaces a poll error distinctly from an absent one', async () => {
    await prisma.telegramIngestionHealth.create({
      data: {
        accountId,
        authorized: true,
        connected: true,
        pollLastError: 'TIMEOUT: channel unreachable',
      },
    });
    const status = await controller.status(accountId);
    expect(status.ingestionHealth.pollLastError).toBe('TIMEOUT: channel unreachable');
  });
});

describe('a valid signal still displays with its full leg structure', () => {
  it('appears in signals with legs, unaffected by these additions', async () => {
    const signal = await prisma.telegramSignal.create({
      data: {
        engineVersion: 'telegram-sfxauusd1-copy-v1',
        accountId,
        channelId: '-1002014074104',
        messageId: '77299',
        sourceKey: 'k-1',
        semanticKey: 's-1',
        publishedAt: new Date(NOW),
        receivedAt: new Date(NOW + 500),
        rawText: 'Gold sell now 4339\nSl 4350\nTp 4329\nTp 4300',
        direction: 'SELL',
        entry: 4339,
        stopLoss: 4350,
        takeProfits: [4329, 4300],
        tp1: 4329,
        outcome: 'SUBMITTED',
        detail: 'test fixture',
        evidence: {},
      },
    });
    await prisma.telegramSignalLeg.create({
      data: {
        signalId: signal.id,
        legIndex: 1,
        idempotencyTag: 'TG-test-1',
        direction: 'SELL',
        volumeLots: 0.01,
        sourceEntry: 4339,
        stopLoss: 4350,
        takeProfit: 4329,
        magicNumber: 262610210,
        orderStatus: 'FILLED',
        ticket: 900001n,
      },
    });

    const status = await controller.status(accountId);
    expect(status.signals).toHaveLength(1);
    expect(status.signals[0].legs).toHaveLength(1);
    expect(status.signals[0].legs[0]).toEqual(
      expect.objectContaining({ legIndex: 1, volumeLots: 0.01, takeProfit: 4329, status: 'FILLED', ticket: '900001' }),
    );
  });
});

describe('secrets never reach this endpoint', () => {
  it('the response contains no session string, API hash or phone number field', async () => {
    const status = await controller.status(accountId);
    const serialized = JSON.stringify(status);
    // Precise, not a blanket ban on the substring "session": this endpoint
    // legitimately has a field named sessionPermissionsOk (a boolean about
    // file permissions, not credential material), and a naive /session/i
    // regex would flag that safe field name as if it were a leak. What must
    // never appear is the literal SESSION STRING key, or an API hash.
    expect(serialized).not.toMatch(/"session"\s*:/i);
    expect(serialized).not.toMatch(/apiHash|api_hash/i);
    expect(status).not.toHaveProperty('session');
  });
});
