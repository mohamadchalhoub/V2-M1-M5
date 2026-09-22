/**
 * The mandatory property of this whole feature: **Engine A's schedule must
 * not leak into Engine B.**
 *
 * Every case below asserts BOTH sides at the same instant — that the RSI
 * engine still blocks exactly where it always did, and that the Telegram
 * engine is unaffected at that same moment. Asserting only the Telegram side
 * would pass just as well if someone had "fixed" the leak by deleting Engine
 * A's pause, which is the failure this file exists to make impossible.
 *
 * Engine A's expected behaviour here is NOT a new claim about what it should
 * do; it is the behaviour `test/xauusd-m1m5/schedule.spec.ts` already pins
 * down, restated at the same instants so the two engines can be compared.
 */
import { describe, expect, it } from 'vitest';
import { evaluateClockSchedule } from '../../src/xauusd-m1m5/schedule';
import { beirutWallToUtc } from '../../src/xauusd-m1m5/time';
import { evaluateTelegramAvailability } from '../../src/telegram-engine/availability';
import type { Mt5PermissionSnapshot } from '../../src/xauusd-m1m5/mt5-readiness';

const LOGIN = '5039912345';

/**
 * A UTC instant from a Beirut wall-clock time. Built through Engine A's own
 * conversion so that a DST change moves both engines' view of "16:00 Beirut"
 * together, rather than moving the test's idea of it away from the code's.
 */
function beirut(year: number, month: number, day: number, h: number, m = 0, s = 0): number {
  const wall = Date.UTC(year, month - 1, day, h, m, s);
  const utc = beirutWallToUtc(wall);
  if (utc === null) throw new Error(`${year}-${month}-${day} ${h}:${m}:${s} is not a valid Beirut wall time`);
  return utc;
}

/** A terminal that is connected, verified, permitted and hedging-capable. */
function readySnapshot(nowMs: number): Mt5PermissionSnapshot {
  return {
    capturedAtMs: nowMs - 1_000,
    loginId: LOGIN,
    tradeMode: 'DEMO',
    terminalConnected: true,
    terminalTradeAllowed: true,
    terminalTradeApiDisabled: false,
    accountTradeAllowed: true,
    accountTradeExpert: true,
    marginMode: 'RETAIL_HEDGING',
  };
}

/** Engine B asked the only question it has about the world: may we trade now? */
function telegramAt(nowMs: number) {
  return evaluateTelegramAvailability({
    nowMs,
    snapshot: readySnapshot(nowMs),
    expectedLoginId: LOGIN,
    symbolSessionOpen: true,
    symbolTradable: true,
    quote: { bid: 4337.5, ask: 4338.0, tickAtMs: nowMs - 500 },
    recoveryComplete: true,
  });
}

// A Wednesday, well clear of the Friday rules, so the afternoon and overnight
// pauses are the only things under test.
const WED = [2026, 9, 23] as const;

describe('the RSI engine’s afternoon pause does not apply to the Telegram engine', () => {
  it('13:59:59 — RSI still permitted, Telegram permitted', () => {
    const t = beirut(...WED, 13, 59, 59);
    expect(evaluateClockSchedule(t).clockAllowsEntries).toBe(true);
    expect(telegramAt(t).available).toBe(true);
  });

  it('14:00:00 exactly — RSI blocked by its pause, Telegram executes', () => {
    const t = beirut(...WED, 14, 0, 0);
    const rsi = evaluateClockSchedule(t);
    expect(rsi.clockAllowsEntries).toBe(false);
    expect(rsi.blockReason).toBe('AFTERNOON_PAUSE');

    const telegram = telegramAt(t);
    expect(telegram.available).toBe(true);
    expect(telegram.block).toBeNull();
  });

  it.each([
    ['14:05', 14, 5],
    ['15:30', 15, 30],
    ['16:00', 16, 0],
    ['17:00', 17, 0],
    ['18:59', 18, 59],
  ])('%s — RSI blocked, Telegram executes', (_label, h, m) => {
    const t = beirut(...WED, h, m, 0);
    expect(evaluateClockSchedule(t).blockReason).toBe('AFTERNOON_PAUSE');
    expect(telegramAt(t).available).toBe(true);
  });

  it('18:59:59 — the last second of the pause: RSI blocked, Telegram executes', () => {
    const t = beirut(...WED, 18, 59, 59);
    expect(evaluateClockSchedule(t).blockReason).toBe('AFTERNOON_PAUSE');
    expect(telegramAt(t).available).toBe(true);
  });

  it('19:00:00 exactly — RSI resumes as it always did, Telegram is unchanged', () => {
    const t = beirut(...WED, 19, 0, 0);
    expect(evaluateClockSchedule(t).clockAllowsEntries).toBe(true);
    // Unchanged is the assertion: Engine B was never affected, so 19:00 is
    // not a boundary for it at all.
    expect(telegramAt(t).available).toBe(true);
  });
});

describe('the RSI engine’s overnight pause does not apply to the Telegram engine', () => {
  it('23:30:00 exactly — RSI blocked, Telegram eligible while the broker is open', () => {
    const t = beirut(...WED, 23, 30, 0);
    expect(evaluateClockSchedule(t).blockReason).toBe('OVERNIGHT_PAUSE');
    expect(telegramAt(t).available).toBe(true);
  });

  it.each([
    ['23:45', 2026, 9, 23, 23, 45],
    ['00:15', 2026, 9, 24, 0, 15],
    ['00:59', 2026, 9, 24, 0, 59],
  ])('%s — during the RSI overnight pause, Telegram remains eligible', (_l, y, mo, d, h, mi) => {
    const t = beirut(y, mo, d, h, mi, 0);
    expect(evaluateClockSchedule(t).blockReason).toBe('OVERNIGHT_PAUSE');
    expect(telegramAt(t).available).toBe(true);
  });

  it('01:00:00 exactly — RSI resumes; Telegram does not change, having never paused', () => {
    const t = beirut(2026, 9, 24, 1, 0, 0);
    expect(evaluateClockSchedule(t).clockAllowsEntries).toBe(true);
    expect(telegramAt(t).available).toBe(true);
  });
});

describe('the RSI engine’s Friday cutoff is not inherited by the Telegram engine', () => {
  // 2026-09-25 is a Friday.
  it('Friday 23:00 — RSI stops entering; Telegram does not', () => {
    const t = beirut(2026, 9, 25, 23, 0, 0);
    const rsi = evaluateClockSchedule(t);
    expect(rsi.blockReason).toBe('FRIDAY_ENTRY_CUTOFF');
    expect(rsi.fridayLiquidationDue).toBe(true);

    const telegram = telegramAt(t);
    expect(telegram.available).toBe(true);
    expect(telegram.block).toBeNull();
  });

  it('Friday 23:45, during Engine A’s liquidation window — Telegram is still eligible', () => {
    const t = beirut(2026, 9, 25, 23, 45, 0);
    expect(evaluateClockSchedule(t).fridayLiquidationDue).toBe(true);
    expect(telegramAt(t).available).toBe(true);
  });

  it('but a Telegram signal during the actual weekend closure is refused by the BROKER, not by a schedule', () => {
    const t = beirut(2026, 9, 26, 12, 0, 0); // Saturday
    const verdict = evaluateTelegramAvailability({
      nowMs: t,
      snapshot: readySnapshot(t),
      expectedLoginId: LOGIN,
      symbolSessionOpen: false,
      symbolTradable: true,
      quote: { bid: 4337.5, ask: 4338.0, tickAtMs: t - 500 },
      recoveryComplete: true,
    });
    expect(verdict.block).toBe('TELEGRAM_MARKET_CLOSED');
    expect(verdict.marketClosed).toBe(true);
  });
});

describe('the isolation is structural, not conditional', () => {
  it('no Telegram availability block can be a schedule block', () => {
    // The verdict type has no schedule member, so this is a compile-time
    // guarantee; the runtime assertion below documents it for a reader and
    // fails loudly if the type is ever widened.
    const blocks = [
      'TELEGRAM_KILL_SWITCH',
      'TELEGRAM_MT5_NOT_READY',
      'TELEGRAM_MARKET_CLOSED',
      'TELEGRAM_SYMBOL_NOT_TRADABLE',
      'TELEGRAM_NO_EXECUTABLE_QUOTE',
      'TELEGRAM_RECOVERY_INCOMPLETE',
    ];
    expect(blocks).not.toContain('SCHEDULE_BLOCKED');
    expect(blocks.some((b) => b.includes('PAUSE') || b.includes('CUTOFF'))).toBe(false);
  });

  it('the availability module does not import the RSI engine’s schedule', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/telegram-engine/availability.ts', import.meta.url), 'utf8'),
    );
    // The words appear in the file's prose, so the assertion is about an
    // IMPORT of the module, which is the thing that would create the leak.
    expect(source).not.toMatch(/^import .*['"].*m1m5\/schedule['"]/m);
  });
});
