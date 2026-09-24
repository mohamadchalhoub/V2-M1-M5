/**
 * Every alert xauusd-sar-v1 sends. One header on all of them, so a message
 * from this strategy is never mistaken for the frozen RSI strategy's or
 * Engine B's.
 *
 * Delivery deliberately reuses `TelegramEngineNotificationService` — the
 * exact same sender, dedup table and recipient list Engine B already uses,
 * rather than a parallel implementation with its own env vars. That service
 * reads `TELEGRAM_ENGINE_NOTIFY_TRADING_CHAT_IDS` (falling back to the
 * existing `XAUUSD_M1M5_TELEGRAM_TRADING_CHAT_IDS`), so ONE recipient list —
 * already configured — reaches Engine A's alerts (legacy RSI and this
 * strategy alike) and Engine B's alike. Adding a recipient there adds them
 * everywhere at once; there is no separate xauusd-sar chat-id variable to
 * remember to update too.
 *
 * Importing this ONE provider (not the whole `TelegramEngineModule`) is the
 * same exception `xauusd-sar.module.ts` already documents for
 * `M1M5Mt5SnapshotService`: genuinely shared infrastructure, not a strategy
 * provider. `TelegramEngineNotificationService` contains no Engine B
 * decision, ownership or occupancy logic — it only sends text.
 */
import type { SarDirection } from './spec';

const HEADER = 'ENGINE A — STOP & REVERSE';

function compact(lines: (string | null)[]): string {
  return lines.filter((l) => l !== null).join('\n');
}

export function sarSessionInitializedMessage(f: { reference: number; buyTrigger: number; sellTrigger: number }): string {
  return compact([
    `🟢 ${HEADER}`,
    '',
    'SESSION INITIALIZED',
    `Reference: ${f.reference}`,
    `BUY trigger: ${f.buyTrigger}`,
    `SELL trigger: ${f.sellTrigger}`,
  ]);
}

export function sarInitialTriggerMessage(f: { direction: SarDirection; fillPrice: number; volume: number }): string {
  return compact([
    `🟢 ${HEADER}`,
    '',
    'INITIAL DIRECTION TRIGGERED',
    `Direction: ${f.direction}`,
    `Fill price: ${f.fillPrice}`,
    `Volume: ${f.volume}`,
  ]);
}

export function sarReversalMessage(f: { from: SarDirection; to: SarDirection; fillPrice: number; volume: number }): string {
  return compact([
    `🔁 ${HEADER}`,
    '',
    'REVERSAL TRIGGERED',
    `${f.from} → ${f.to}`,
    `Fill price: ${f.fillPrice}`,
    `Volume: ${f.volume}`,
  ]);
}

export function sarUnknownMessage(f: { kind: string; direction: SarDirection; cycleId: string; error: string }): string {
  return compact([
    `🚨 ${HEADER}`,
    '',
    'EXECUTION UNKNOWN',
    `${f.kind} ${f.direction}`,
    `Cycle: ${f.cycleId}`,
    `Detail: ${f.error}`,
    '',
    'Engine A is blocked until reconciliation resolves this. Engine B is unaffected.',
  ]);
}

export function sarDailyClosedMessage(f: { sessionDate: string }): string {
  return compact([`🔵 ${HEADER}`, '', `DAILY CLOSED — ${f.sessionDate}`, 'Next session: 01:00 Asia/Beirut.']);
}

export function sarReconciliationIncidentMessage(f: { detail: string }): string {
  return compact([`🚨 ${HEADER}`, '', 'RECONCILIATION INCIDENT', f.detail]);
}

/**
 * A $10 catastrophic backstop closure is never a normal SAR trade — its
 * existence means the real $0.50 reversal pipeline failed to act for as
 * long as it took price to travel the full $10. High severity, deliberately
 * distinguishable from every other message here.
 */
export function sarCatastrophicBackstopMessage(f: {
  readonly ticket: string;
  readonly cycleId: string;
  readonly direction: SarDirection;
  readonly entryFillPrice: number;
  readonly exitFillPrice: number;
  readonly adverseDistanceUsd: number;
  readonly lastKnownExtreme: number | null;
  readonly lastKnownReversalLevel: number | null;
  readonly lastEvaluatedAt: string | null;
  readonly thresholdWasPreviouslyCrossed: boolean;
  readonly volumeLots: number | null;
}): string {
  return compact([
    `🆘 ${HEADER}`,
    '',
    'ENGINE A — CATASTROPHIC BACKSTOP ACTIVATED',
    'This is a strategy execution failure, not an ordinary SAR trade.',
    '',
    `Ticket: ${f.ticket}  Cycle: ${f.cycleId}`,
    `Direction: ${f.direction}  Volume: ${f.volumeLots ?? 'unknown'}`,
    `Entry: ${f.entryFillPrice}   Catastrophic exit: ${f.exitFillPrice}`,
    `Adverse distance: $${f.adverseDistanceUsd.toFixed(2)}`,
    `Last known extreme: ${f.lastKnownExtreme ?? 'unknown'}`,
    `Last known $0.50 reversal level: ${f.lastKnownReversalLevel ?? 'unknown'}`,
    `Last normal evaluation: ${f.lastEvaluatedAt ?? 'never recorded'}`,
    f.thresholdWasPreviouslyCrossed
      ? 'The $0.50 threshold HAD already been crossed before this backstop fired -- the reversal pipeline was stale, not merely gapped past.'
      : 'The $0.50 threshold had NOT been crossed by the last known reversal level -- consistent with a genuine price gap straight past both levels, not a stalled pipeline.',
  ]);
}
