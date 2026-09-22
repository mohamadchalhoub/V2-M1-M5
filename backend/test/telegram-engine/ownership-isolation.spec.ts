/**
 * The ownership separation between the two engines, asserted from both sides.
 *
 * The requirement is mandatory and asymmetric in consequence: Engine A runs a
 * Friday liquidation that closes positions, so the case that must never
 * happen is Engine A selecting a Telegram position. That is proved here
 * against Engine A's REAL planner, with a real mixed broker list, rather than
 * against a restatement of what it is believed to do.
 */
import { describe, expect, it } from 'vitest';
import { planLiquidation, type BrokerItem } from '../../src/xauusd-m1m5/liquidation';
import {
  isOwnedByThisApplication,
  timeframeForPosition,
} from '../../src/xauusd-m1m5/ownership';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';
import {
  assertEngineSeparation,
  classifyForeignToTelegram,
  isOwnedByTelegramEngine,
} from '../../src/telegram-engine/ownership';
import { TELEGRAM_MAGIC } from '../../src/telegram-engine/safety-constants';

const item = (ticket: string, magicNumber: number | null): BrokerItem => ({
  ticket,
  kind: 'POSITION',
  symbol: 'XAUUSD',
  magicNumber,
  volume: 0.01,
});

const MIXED_ACCOUNT: BrokerItem[] = [
  item('A-1', V2_MAGIC_M1),
  item('A-2', V2_MAGIC_M5),
  item('B-1', TELEGRAM_MAGIC),
  item('B-2', TELEGRAM_MAGIC),
  item('OTHER', 262610190), // the still-running previous bot
  item('MANUAL', null),
];

describe('Engine A’s Friday liquidation never touches a Telegram position', () => {
  const plan = planLiquidation(MIXED_ACCOUNT);

  it('targets only its own M1 and M5 positions', () => {
    expect(plan.targets.map((t) => t.ticket).sort()).toEqual(['A-1', 'A-2']);
  });

  it('leaves both Telegram legs alone', () => {
    const excluded = plan.excluded.map((e) => e.ticket);
    expect(excluded).toContain('B-1');
    expect(excluded).toContain('B-2');
  });

  it('says WHY a Telegram position was left alone, rather than silently omitting it', () => {
    const reason = plan.excluded.find((e) => e.ticket === 'B-1')!.reason;
    expect(reason).toMatch(/never closes, modifies, adopts or relabels it|never closed or modified/i);
  });

  it('still leaves the other bot’s and the manual positions alone', () => {
    const excluded = plan.excluded.map((e) => e.ticket);
    expect(excluded).toContain('OTHER');
    expect(excluded).toContain('MANUAL');
  });

  it('does not recognise the Telegram magic as its own, in either helper', () => {
    expect(isOwnedByThisApplication(TELEGRAM_MAGIC)).toBe(false);
    expect(timeframeForPosition(TELEGRAM_MAGIC)).toBeNull();
  });
});

describe('the Telegram engine never touches an Engine A position', () => {
  it('owns only its own magic', () => {
    expect(isOwnedByTelegramEngine(TELEGRAM_MAGIC)).toBe(true);
    expect(isOwnedByTelegramEngine(V2_MAGIC_M1)).toBe(false);
    expect(isOwnedByTelegramEngine(V2_MAGIC_M5)).toBe(false);
  });

  it('classifies an Engine A position as Engine A’s, specifically', () => {
    const foreign = classifyForeignToTelegram(V2_MAGIC_M1)!;
    expect(foreign.kind).toBe('ENGINE_A');
    expect(foreign.detail).toMatch(/RSI M1\/M5 engine/);
  });

  it('treats an unattributable position as foreign, which is the safe default', () => {
    expect(classifyForeignToTelegram(null)!.kind).toBe('MANUAL_OR_UNKNOWN');
    expect(classifyForeignToTelegram(999999)!.kind).toBe('MANUAL_OR_UNKNOWN');
  });
});

describe('the separation is asserted at startup, not discovered at 23:00 on a Friday', () => {
  it('passes for the constants actually in force', () => {
    expect(() => assertEngineSeparation()).not.toThrow();
  });

  it('the two engines’ magic registries are disjoint', () => {
    expect([V2_MAGIC_M1, V2_MAGIC_M5]).not.toContain(TELEGRAM_MAGIC);
  });
});
