import { ConfigService } from '@nestjs/config';

export interface TelegramConfig {
  botToken: string;
  tradingChatIds: string[];
  opsChatIds: string[];
  reconciliationIntervalMs: number;
  /** §7 — a PENDING/FAILED row idle longer than this is re-enqueued by the sweep. */
  staleThresholdMs: number;
}

export const TELEGRAM_CONFIG = Symbol('TELEGRAM_CONFIG');

// Retry/backoff (TELEGRAM_DELIVERY_MAX_ATTEMPTS/_BACKOFF_MS) are read in
// jobs.module.ts as queue-level defaultJobOptions, not here — see that
// file's comment for why. This config is only what message rendering and
// the reconciliation sweep actually need.
const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 2 * 60_000;

/**
 * Validated once, at startup (Req. 9) — a NestJS `useFactory` provider throws
 * here during DI container construction, which fails `NestFactory.create(...)`
 * before the app ever binds a port. Missing Telegram config is a deployment
 * mistake, not a runtime condition to degrade gracefully from — unlike a
 * Telegram API outage (handled at delivery time, PHASE5_DELIVERY_SPEC.md §8),
 * which must never stop the app from starting or ingesting.
 */
export function loadTelegramConfig(config: ConfigService): TelegramConfig {
  const botToken = config.get<string>('TELEGRAM_BOT_TOKEN')?.trim();
  const tradingChatIdsRaw = config.get<string>('TELEGRAM_TRADING_CHAT_IDS')?.trim();
  const opsChatIdsRaw = config.get<string>('TELEGRAM_OPS_CHAT_IDS')?.trim();

  const missing = [
    ['TELEGRAM_BOT_TOKEN', botToken],
    ['TELEGRAM_TRADING_CHAT_IDS', tradingChatIdsRaw],
    ['TELEGRAM_OPS_CHAT_IDS', opsChatIdsRaw],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required Telegram configuration: ${missing.join(', ')}. See backend/.env.example.`,
    );
  }

  return {
    botToken: botToken as string,
    tradingChatIds: parseChatIds(tradingChatIdsRaw as string),
    opsChatIds: parseChatIds(opsChatIdsRaw as string),
    reconciliationIntervalMs: readPositiveInt(
      config,
      'DELIVERY_RECONCILIATION_INTERVAL_MS',
      DEFAULT_RECONCILIATION_INTERVAL_MS,
    ),
    staleThresholdMs: readPositiveInt(config, 'DELIVERY_STALE_THRESHOLD_MS', DEFAULT_STALE_THRESHOLD_MS),
  };
}

function parseChatIds(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
