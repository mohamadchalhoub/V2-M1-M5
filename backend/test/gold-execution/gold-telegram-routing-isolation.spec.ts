import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { GoldTelegramService } from '../../src/gold-execution/gold-telegram.service';

/**
 * Proves the gold Telegram path never touches the shared legacy Telegram
 * config (TELEGRAM_BOT_TOKEN / TELEGRAM_TRADING_CHAT_IDS / TELEGRAM_OPS_CHAT_IDS)
 * — it must read GOLD_TELEGRAM_BOT_TOKEN / GOLD_TELEGRAM_CHAT_ID directly and
 * use ONLY those values in the actual HTTP call, entirely independent of
 * TelegramConfig/TELEGRAM_CONFIG.
 */
describe('GoldTelegramService — routing isolation from the shared legacy Telegram config', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let prismaMock: any;
  let configValues: Record<string, string>;
  let configService: ConfigService;

  beforeEach(() => {
    configValues = {
      GOLD_TELEGRAM_BOT_TOKEN: 'gold-bot-token-123',
      GOLD_TELEGRAM_CHAT_ID: '999888777',
      // Deliberately present and DIFFERENT from the gold values, to prove
      // the service never reaches for these even though they're available
      // on the same ConfigService.
      TELEGRAM_BOT_TOKEN: 'legacy-bot-token-should-never-be-used',
      TELEGRAM_TRADING_CHAT_IDS: '111,222',
      TELEGRAM_OPS_CHAT_IDS: '333,444',
    };
    configService = { get: (key: string) => configValues[key] } as unknown as ConfigService;

    prismaMock = {
      goldTelegramNotification: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends to the gold bot token/chat id only, never the legacy ones', async () => {
    const service = new GoldTelegramService(prismaMock, configService);
    await service.notify('FILL_CONFIRMED', 'dedup-1', 'test message');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];

    expect(url).toContain('gold-bot-token-123');
    expect(url).not.toContain('legacy-bot-token-should-never-be-used');

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.chat_id).toBe('999888777');
    expect(body.chat_id).not.toBe('111');
    expect(body.chat_id).not.toBe('333');
  });

  it('persists a dedup row via GoldTelegramNotification (own table), not any shared AlertDelivery-style call', async () => {
    const service = new GoldTelegramService(prismaMock, configService);
    await service.notify('FILL_CONFIRMED', 'dedup-2', 'test message');

    // Per-recipient key: the destination chat is appended to the caller's
    // logical key, which is what lets a retry re-send only what failed.
    expect(prismaMock.goldTelegramNotification.findUnique).toHaveBeenCalledWith({
      where: { dedupKey: expect.stringContaining('dedup-2#chat:') },
    });
    expect(prismaMock.goldTelegramNotification.upsert).toHaveBeenCalledTimes(1);
  });

  it('skips sending entirely when a dedupKey was already SENT (durable dedup)', async () => {
    prismaMock.goldTelegramNotification.findUnique.mockResolvedValue({ status: 'SENT', messageId: 7 });
    const service = new GoldTelegramService(prismaMock, configService);
    await service.notify('FILL_CONFIRMED', 'dedup-3', 'test message');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.goldTelegramNotification.upsert).not.toHaveBeenCalled();
  });

  it('fails closed (logs, does not throw) when GOLD_TELEGRAM_BOT_TOKEN/CHAT_ID are unset', async () => {
    configValues.GOLD_TELEGRAM_BOT_TOKEN = '';
    configValues.GOLD_TELEGRAM_CHAT_ID = '';
    const service = new GoldTelegramService(prismaMock, configService);

    // `notify` now returns a per-recipient delivery report rather than void,
    // so the assertion is that it RESOLVES with the problem described rather
    // than throwing into the trading path that called it.
    const report = await service.notify('FILL_CONFIRMED', 'dedup-4', 'test message');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.results).toHaveLength(0);
    expect(report.problems.join(' ')).toMatch(/not configured/);
  });

  it('still sends to the remaining recipients when one of them is malformed', async () => {
    // One recipient's configuration being wrong must not silence the others.
    configValues.GOLD_TELEGRAM_BOT_TOKEN = 'token';
    configValues.GOLD_TELEGRAM_CHAT_ID = '111';
    configValues.GOLD_TELEGRAM_CHAT_IDS = 'Broken:not-a-number,Friend:222';
    const service = new GoldTelegramService(prismaMock, configService);

    const report = await service.notify('FILL_CONFIRMED', 'dedup-5', 'test message');

    expect(report.problems.join(' ')).toMatch(/not a valid Telegram chat id/);
    expect(report.results.map((r) => r.recipient.chatId).sort()).toEqual(['111', '222']);
  });
});
