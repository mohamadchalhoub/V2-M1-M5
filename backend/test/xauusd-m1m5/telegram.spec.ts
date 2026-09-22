/**
 * Telegram delivery for this strategy (§13).
 *
 * The behaviours worth testing are the ones that only show up when something
 * goes wrong: that a transient failure is recoverable rather than permanent,
 * that a retry re-sends only the recipient that failed, and that the bot token
 * never reaches stored text. The happy path is one assertion.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  M1M5TelegramService,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  readTelegramConfig,
  redact,
  type TelegramConfig,
} from '../../src/xauusd-m1m5/telegram.service';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();

const CONFIG: TelegramConfig = {
  botToken: 'secret-token',
  tradingChatIds: [
    { chatId: '111', label: 'Owner' },
    { chatId: '222', label: 'Friend' },
  ],
  opsChatIds: [{ chatId: '999', label: 'Ops' }],
};

function okResponse(messageId = 7) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  } as unknown as Response;
}

function service(fetchImpl: typeof fetch, config: TelegramConfig = CONFIG) {
  return new M1M5TelegramService(prisma, config, fetchImpl);
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('configuration', () => {
  it('reads THIS strategy’s own variables, never the generic ones', () => {
    // Two systems reading one variable is how a message ends up in the wrong
    // channel. The generic TELEGRAM_* belong to the retained delivery layer.
    const config = readTelegramConfig({
      XAUUSD_M1M5_TELEGRAM_BOT_TOKEN: 'mine',
      XAUUSD_M1M5_TELEGRAM_TRADING_CHAT_IDS: 'Owner:111, 222',
      TELEGRAM_BOT_TOKEN: 'someone-elses',
      TELEGRAM_TRADING_CHAT_IDS: '333',
    } as NodeJS.ProcessEnv);

    expect(config.botToken).toBe('mine');
    expect(config.tradingChatIds).toEqual([
      { label: 'Owner', chatId: '111' },
      { label: null, chatId: '222' },
    ]);
  });

  it('redacts the bot token out of anything about to be stored', () => {
    // Telegram echoes the request URL, token included, in some error bodies.
    expect(redact('failed calling bot secret-token/sendMessage', 'secret-token')).toBe(
      'failed calling bot <redacted-token>/sendMessage',
    );
  });
});

describe('delivery', () => {
  it('sends one message per recipient and records each', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await service(fetchImpl as unknown as typeof fetch).notify('FILL_CONFIRMED', 'fill:1', 'filled');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const rows = await prisma.xauusdM1M5TelegramNotification.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'SENT')).toBe(true);
  });

  it('routes an OPS event to the ops chats only', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await service(fetchImpl as unknown as typeof fetch).notify('LIQUIDATION_FAILED', 'liq:1', 'help', 'OPS');

    const rows = await prisma.xauusdM1M5TelegramNotification.findMany();
    expect(rows.map((r) => r.chatId)).toEqual(['999']);
  });

  it('does not send the same event twice', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const telegram = service(fetchImpl as unknown as typeof fetch);

    await telegram.notify('FILL_CONFIRMED', 'fill:1', 'filled');
    await telegram.notify('FILL_CONFIRMED', 'fill:1', 'filled');

    expect(fetchImpl).toHaveBeenCalledTimes(2); // two recipients, once each
  });

  it('never throws at the caller, whatever the network does', async () => {
    // Callers invoke this fire-and-forget after an outcome is already durable.
    // An exception here would surface at an unrelated await.
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(
      service(fetchImpl as unknown as typeof fetch).notify('FILL_CONFIRMED', 'fill:1', 'filled'),
    ).resolves.toBeUndefined();
  });

  it('records but does not deliver when Telegram is not configured', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const telegram = service(fetchImpl as unknown as typeof fetch, {
      botToken: null,
      tradingChatIds: [],
      opsChatIds: [],
    });

    await telegram.notify('FILL_CONFIRMED', 'fill:1', 'filled');

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('failure is recoverable, not final', () => {
  it('leaves a failed send PENDING so the sweep can find it', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await service(fetchImpl as unknown as typeof fetch).notify('FILL_CONFIRMED', 'fill:1', 'filled');

    const rows = await prisma.xauusdM1M5TelegramNotification.findMany();
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it('re-sends only the recipient that failed', async () => {
    // One recipient's success must not hide another's failure, which is why
    // dedup is per recipient rather than per event.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error('network down');
      return okResponse();
    });
    const telegram = service(fetchImpl as unknown as typeof fetch);
    await telegram.notify('FILL_CONFIRMED', 'fill:1', 'filled');

    const sent = await prisma.xauusdM1M5TelegramNotification.count({ where: { status: 'SENT' } });
    expect(sent).toBe(1);

    // Age the pending row past its backoff, then sweep.
    await prisma.xauusdM1M5TelegramNotification.updateMany({
      where: { status: 'PENDING' },
      data: { lastAttemptAt: new Date(Date.now() - RETRY_BACKOFF_MS - 1000) },
    });
    const retried = await telegram.retryPending(Date.now());

    expect(retried).toBe(1);
    expect(await prisma.xauusdM1M5TelegramNotification.count({ where: { status: 'SENT' } })).toBe(2);
  });

  it('does not retry before the backoff has elapsed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const telegram = service(fetchImpl as unknown as typeof fetch);
    await telegram.notify('FILL_CONFIRMED', 'fill:1', 'filled');

    expect(await telegram.retryPending(Date.now())).toBe(0);
  });

  it('gives up visibly rather than retrying a revoked token forever', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Unauthorized');
    });
    const telegram = service(fetchImpl as unknown as typeof fetch, {
      ...CONFIG,
      tradingChatIds: [{ chatId: '111', label: 'Owner' }],
    });
    await telegram.notify('FILL_CONFIRMED', 'fill:1', 'filled');

    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      await prisma.xauusdM1M5TelegramNotification.updateMany({
        where: { status: 'PENDING' },
        data: { lastAttemptAt: new Date(Date.now() - RETRY_BACKOFF_MS - 1000) },
      });
      await telegram.retryPending(Date.now());
    }

    const row = await prisma.xauusdM1M5TelegramNotification.findFirst();
    expect(row?.status).toBe('FAILED');
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('never stores the bot token in the error it records', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('failed calling https://api.telegram.org/botsecret-token/sendMessage');
    });
    await service(fetchImpl as unknown as typeof fetch).notify('FILL_CONFIRMED', 'fill:1', 'filled');

    const row = await prisma.xauusdM1M5TelegramNotification.findFirst();
    expect(row?.lastError).not.toContain('secret-token');
    expect(row?.lastError).toContain('<redacted-token>');
  });

  it('treats a Telegram-level ok:false as a failure, not a success', async () => {
    // HTTP 200 with ok:false is how Telegram reports "chat not found".
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: false, description: 'chat not found' }),
        }) as unknown as Response,
    );
    await service(fetchImpl as unknown as typeof fetch).notify('FILL_CONFIRMED', 'fill:1', 'filled');

    const rows = await prisma.xauusdM1M5TelegramNotification.findMany();
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
    expect(rows[0]?.lastError).toContain('chat not found');
  });
});
