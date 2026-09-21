import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { loadTelegramConfig } from '../../src/telegram/telegram.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadTelegramConfig — Req. 9: validate configuration at startup', () => {
  it('throws a clear error listing every missing required var, not just the first', () => {
    const config = configWith({});
    expect(() => loadTelegramConfig(config)).toThrow(
      /TELEGRAM_BOT_TOKEN.*TELEGRAM_TRADING_CHAT_IDS.*TELEGRAM_OPS_CHAT_IDS/s,
    );
  });

  it('throws when only the bot token is missing', () => {
    const config = configWith({ TELEGRAM_TRADING_CHAT_IDS: '-100', TELEGRAM_OPS_CHAT_IDS: '-200' });
    expect(() => loadTelegramConfig(config)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('parses comma-separated chat ids, trimming whitespace', () => {
    const config = configWith({
      TELEGRAM_BOT_TOKEN: 'tok',
      TELEGRAM_TRADING_CHAT_IDS: ' -100, -200 ,-300',
      TELEGRAM_OPS_CHAT_IDS: '-999',
    });
    const result = loadTelegramConfig(config);
    expect(result.tradingChatIds).toEqual(['-100', '-200', '-300']);
    expect(result.opsChatIds).toEqual(['-999']);
  });

  it('falls back to the default reconciliation interval when unset or invalid', () => {
    const base = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_TRADING_CHAT_IDS: '-100', TELEGRAM_OPS_CHAT_IDS: '-200' };
    expect(loadTelegramConfig(configWith(base)).reconciliationIntervalMs).toBe(60_000);
    expect(
      loadTelegramConfig(configWith({ ...base, DELIVERY_RECONCILIATION_INTERVAL_MS: 'not-a-number' }))
        .reconciliationIntervalMs,
    ).toBe(60_000);
    expect(
      loadTelegramConfig(configWith({ ...base, DELIVERY_RECONCILIATION_INTERVAL_MS: '5000' })).reconciliationIntervalMs,
    ).toBe(5000);
  });
});
