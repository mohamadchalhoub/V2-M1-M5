import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBotClient } from '../../src/telegram/telegram-bot.client';
import { TelegramPermanentError, TelegramTransientError } from '../../src/telegram/telegram.errors';
import type { TelegramConfig } from '../../src/telegram/telegram.config';

const config: TelegramConfig = {
  botToken: 'super-secret-token-12345',
  tradingChatIds: ['-100111'],
  opsChatIds: ['-100222'],
  reconciliationIntervalMs: 60_000,
};

function mockFetchOnce(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
    async () => new Response(JSON.stringify(body), { status }),
  );
}

describe('TelegramBotClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the Telegram message id on success', async () => {
    mockFetchOnce(200, { ok: true, result: { message_id: 42 } });
    const client = new TelegramBotClient(config);
    await expect(client.sendMessage('-100111', 'hello')).resolves.toBe(42);
  });

  it('classifies HTTP 400 as permanent', async () => {
    mockFetchOnce(400, { ok: false, description: 'Bad Request: chat not found' });
    const client = new TelegramBotClient(config);
    await expect(client.sendMessage('-100111', 'hello')).rejects.toBeInstanceOf(TelegramPermanentError);
  });

  it('classifies HTTP 403 as permanent (bot blocked)', async () => {
    mockFetchOnce(403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
    const client = new TelegramBotClient(config);
    await expect(client.sendMessage('-100111', 'hello')).rejects.toBeInstanceOf(TelegramPermanentError);
  });

  it('classifies HTTP 429 as transient', async () => {
    mockFetchOnce(429, { ok: false, error_code: 429, description: 'Too Many Requests' });
    const client = new TelegramBotClient(config);
    await expect(client.sendMessage('-100111', 'hello')).rejects.toBeInstanceOf(TelegramTransientError);
  });

  it('classifies HTTP 5xx as transient', async () => {
    mockFetchOnce(502, { ok: false, description: 'Bad Gateway' });
    const client = new TelegramBotClient(config);
    await expect(client.sendMessage('-100111', 'hello')).rejects.toBeInstanceOf(TelegramTransientError);
  });

  it('classifies a network error as transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new TelegramBotClient(config);
    await expect(client.sendMessage('-100111', 'hello')).rejects.toBeInstanceOf(TelegramTransientError);
  });

  it('never includes the bot token in a thrown error message, for any failure path', async () => {
    mockFetchOnce(400, { ok: false, description: `Bad Request: token ${config.botToken} leaked in body` });
    const client = new TelegramBotClient(config);
    try {
      await client.sendMessage('-100111', 'hello');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(config.botToken);
    }
  });

  it('never includes the bot token in a network-error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      throw new Error(`connect ECONNREFUSED — url had bot${config.botToken} in it`);
    });
    const client = new TelegramBotClient(config);
    try {
      await client.sendMessage('-100111', 'hello');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(config.botToken);
    }
  });
});
