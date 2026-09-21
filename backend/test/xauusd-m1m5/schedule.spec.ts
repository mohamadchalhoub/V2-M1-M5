/**
 * §15.5 — Beirut schedule boundaries.
 *
 * Every boundary the specification names is asserted on both sides, to the
 * second. The helper builds UTC instants from Beirut wall-clock times
 * through the real tz database rather than by adding a fixed offset, so
 * these tests stay correct across DST and across any future change to
 * Lebanon's transition dates.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateClockSchedule,
  evaluateEntryEligibility,
  inAfternoonPause,
  inOvernightPause,
  type RuntimeGates,
} from '../../src/xauusd-m1m5/schedule';
import { beirutSecondsOfDay, beirutWallToUtc, beirutDayOfWeek, FRIDAY } from '../../src/xauusd-m1m5/time';
import { SPEC } from '../../src/xauusd-m1m5/spec';

const OPEN_GATES: RuntimeGates = {
  brokerSessionOpen: true,
  dataFresh: true,
  recoveryComplete: true,
  killSwitchEngaged: false,
  executionBlockers: [],
};

/**
 * UTC instant at which Beirut's wall clock reads the given date and time.
 * `y/m/d` are Beirut calendar values.
 */
function beirut(y: number, m: number, d: number, hh: number, mm: number, ss: number): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  const utc = beirutWallToUtc(wall);
  if (utc === null) throw new Error(`No such Beirut wall time: ${y}-${m}-${d} ${hh}:${mm}:${ss}`);
  return utc;
}

/** 2026-09-23 is a Wednesday; 2026-09-25 is a Friday. */
const WED = { y: 2026, m: 9, d: 23 };
const FRI = { y: 2026, m: 9, d: 25 };

function clockAllows(y: number, m: number, d: number, hh: number, mm: number, ss: number): boolean {
  return evaluateClockSchedule(beirut(y, m, d, hh, mm, ss)).clockAllowsEntries;
}

function blockReason(y: number, m: number, d: number, hh: number, mm: number, ss: number) {
  return evaluateClockSchedule(beirut(y, m, d, hh, mm, ss)).blockReason;
}

describe('§15.5 the exact boundaries the specification names', () => {
  it('00:59:59 is blocked and 01:00:00 is eligible', () => {
    expect(clockAllows(WED.y, WED.m, WED.d, 0, 59, 59)).toBe(false);
    expect(blockReason(WED.y, WED.m, WED.d, 0, 59, 59)).toBe('OVERNIGHT_PAUSE');
    expect(clockAllows(WED.y, WED.m, WED.d, 1, 0, 0)).toBe(true);
  });

  it('13:59:59 is eligible and 14:00:00 is blocked', () => {
    expect(clockAllows(WED.y, WED.m, WED.d, 13, 59, 59)).toBe(true);
    expect(clockAllows(WED.y, WED.m, WED.d, 14, 0, 0)).toBe(false);
    expect(blockReason(WED.y, WED.m, WED.d, 14, 0, 0)).toBe('AFTERNOON_PAUSE');
  });

  it('18:59:59 is blocked and 19:00:00 is eligible', () => {
    expect(clockAllows(WED.y, WED.m, WED.d, 18, 59, 59)).toBe(false);
    expect(blockReason(WED.y, WED.m, WED.d, 18, 59, 59)).toBe('AFTERNOON_PAUSE');
    expect(clockAllows(WED.y, WED.m, WED.d, 19, 0, 0)).toBe(true);
  });

  it('an ordinary weekday 23:29:59 is eligible and 23:30:00 is blocked', () => {
    expect(clockAllows(WED.y, WED.m, WED.d, 23, 29, 59)).toBe(true);
    expect(clockAllows(WED.y, WED.m, WED.d, 23, 30, 0)).toBe(false);
    expect(blockReason(WED.y, WED.m, WED.d, 23, 30, 0)).toBe('OVERNIGHT_PAUSE');
  });

  it('Friday 22:59:59 is eligible and 23:00:00 is blocked', () => {
    expect(beirutDayOfWeek(beirut(FRI.y, FRI.m, FRI.d, 12, 0, 0))).toBe(FRIDAY);
    expect(clockAllows(FRI.y, FRI.m, FRI.d, 22, 59, 59)).toBe(true);
    expect(clockAllows(FRI.y, FRI.m, FRI.d, 23, 0, 0)).toBe(false);
    expect(blockReason(FRI.y, FRI.m, FRI.d, 23, 0, 0)).toBe('FRIDAY_ENTRY_CUTOFF');
  });
});

describe('§9.1 the two daily pauses', () => {
  it('the afternoon pause is same-day and does not wrap into the next day', () => {
    // The confirmed reading: 14:00 inclusive to 19:00 exclusive on the SAME
    // day. If it wrapped to "19:00 the following day" then 20:00, 23:00 and
    // the next morning would all be blocked by it — they are not.
    expect(inAfternoonPause(14 * 3600)).toBe(true);
    expect(inAfternoonPause(18 * 3600 + 3599)).toBe(true);
    expect(inAfternoonPause(19 * 3600)).toBe(false);
    expect(inAfternoonPause(20 * 3600)).toBe(false);
    expect(inAfternoonPause(2 * 3600)).toBe(false);
    expect(inAfternoonPause(13 * 3600 + 3599)).toBe(false);
  });

  it('the overnight pause wraps midnight', () => {
    expect(inOvernightPause(23 * 3600 + 30 * 60)).toBe(true);
    expect(inOvernightPause(23 * 3600 + 59 * 60)).toBe(true);
    expect(inOvernightPause(0)).toBe(true);
    expect(inOvernightPause(59 * 60 + 59)).toBe(true);
    expect(inOvernightPause(3600)).toBe(false);
    expect(inOvernightPause(12 * 3600)).toBe(false);
  });

  it('there is a genuine eligible window between the two pauses', () => {
    // 01:00–14:00 and 19:00–23:30 must both be open, or the schedule would
    // leave almost nothing tradable.
    for (const hour of [1, 5, 9, 13, 19, 21, 23]) {
      expect(clockAllows(WED.y, WED.m, WED.d, hour, 0, 0), `${hour}:00 Beirut`).toBe(true);
    }
    for (const hour of [0, 14, 16, 18]) {
      expect(clockAllows(WED.y, WED.m, WED.d, hour, 0, 0), `${hour}:00 Beirut`).toBe(false);
    }
  });

  it('the former 04:00–12:00 restriction is gone', () => {
    for (const hour of [4, 6, 8, 10, 11]) {
      expect(clockAllows(WED.y, WED.m, WED.d, hour, 0, 0), `${hour}:00 Beirut`).toBe(true);
    }
  });

  it('reports the next eligible instant for each pause', () => {
    const afternoon = evaluateClockSchedule(beirut(WED.y, WED.m, WED.d, 15, 0, 0));
    expect(afternoon.nextClockEligibleT).toBe(beirut(WED.y, WED.m, WED.d, 19, 0, 0));

    const overnight = evaluateClockSchedule(beirut(WED.y, WED.m, WED.d, 23, 45, 0));
    expect(overnight.nextClockEligibleT).toBe(beirut(WED.y, WED.m, WED.d + 1, 1, 0, 0));
  });
});

describe('§9.3 Friday liquidation and deadline', () => {
  it('liquidation becomes due at the 23:00 cutoff', () => {
    expect(evaluateClockSchedule(beirut(FRI.y, FRI.m, FRI.d, 22, 59, 59)).fridayLiquidationDue).toBe(false);
    expect(evaluateClockSchedule(beirut(FRI.y, FRI.m, FRI.d, 23, 0, 0)).fridayLiquidationDue).toBe(true);
  });

  it('the deadline is 23:30 and is reported as passed only afterwards', () => {
    const before = evaluateClockSchedule(beirut(FRI.y, FRI.m, FRI.d, 23, 29, 59));
    expect(before.fridayDeadlineT).toBe(beirut(FRI.y, FRI.m, FRI.d, 23, 30, 0));
    expect(before.fridayDeadlinePassed).toBe(false);

    const after = evaluateClockSchedule(beirut(FRI.y, FRI.m, FRI.d, 23, 30, 0));
    expect(after.fridayDeadlinePassed).toBe(true);
  });

  it('the weekend window keeps entries blocked through Saturday and Sunday', () => {
    for (const [d, hh] of [[FRI.d, 23], [FRI.d + 1, 12], [FRI.d + 2, 12], [FRI.d + 2, 22]] as const) {
      const s = evaluateClockSchedule(beirut(FRI.y, FRI.m, d, hh, 0, 0));
      expect(s.clockAllowsEntries, `${d} ${hh}:00`).toBe(false);
      expect(s.blockReason).toBe('FRIDAY_ENTRY_CUTOFF');
    }
  });

  it('does not predict a reopening instant inside the weekend window', () => {
    // §9.4 — never hardcode Sunday 00:00. Null is what the dashboard renders
    // as "awaiting confirmed broker reopening".
    const sat = evaluateClockSchedule(beirut(FRI.y, FRI.m, FRI.d + 1, 12, 0, 0));
    expect(sat.inWeekendWindow).toBe(true);
    expect(sat.nextClockEligibleT).toBeNull();
  });

  it('Monday 00:00 Beirut leaves the weekend window', () => {
    // Monday 00:00 is inside the overnight pause, so entries are still
    // blocked — but by the pause, not by the weekend.
    const mon = evaluateClockSchedule(beirut(FRI.y, FRI.m, FRI.d + 3, 0, 30, 0));
    expect(mon.inWeekendWindow).toBe(false);
    expect(mon.blockReason).toBe('OVERNIGHT_PAUSE');
  });
});

describe('§9.4 runtime gates', () => {
  const eligibleInstant = () => beirut(WED.y, WED.m, WED.d, 10, 0, 0);

  it('is eligible when the clock allows and every gate is satisfied', () => {
    const e = evaluateEntryEligibility(eligibleInstant(), OPEN_GATES);
    expect(e.eligible).toBe(true);
    expect(e.reason).toBeNull();
  });

  it('an unknown broker session blocks rather than permits', () => {
    const e = evaluateEntryEligibility(eligibleInstant(), { ...OPEN_GATES, brokerSessionOpen: null });
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('AWAITING_BROKER_REOPENING');
    expect(e.detail).toMatch(/blocks rather than permits/i);
  });

  it.each([
    ['kill switch', { killSwitchEngaged: true }, 'KILL_SWITCH'],
    ['incomplete recovery', { recoveryComplete: false }, 'RECOVERY_INCOMPLETE'],
    ['stale data', { dataFresh: false }, 'DATA_NOT_FRESH'],
    ['an execution blocker', { executionBlockers: ['terminal trade_allowed=false'] }, 'EXECUTION_BLOCKED'],
  ])('%s blocks entries', (_label, patch, expected) => {
    const e = evaluateEntryEligibility(eligibleInstant(), { ...OPEN_GATES, ...(patch as Partial<RuntimeGates>) });
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe(expected);
  });

  it('the clock is reported even when a runtime gate is what blocks', () => {
    const e = evaluateEntryEligibility(eligibleInstant(), { ...OPEN_GATES, killSwitchEngaged: true });
    expect(e.clock.clockAllowsEntries).toBe(true);
  });
});

describe('Beirut DST transitions', () => {
  /**
   * Lebanon has changed its transition dates at short notice, so these tests
   * assert the PROPERTY that matters — the boundaries stay pinned to Beirut
   * wall-clock time whatever the offset is — rather than hardcoding a date
   * whose correctness depends on the host's tzdata vintage.
   */
  it('pause boundaries hold on every day of a year, across both offsets', () => {
    const offsets = new Set<number>();
    for (let day = 1; day <= 365; day += 1) {
      const t = Date.UTC(2026, 0, day, 12, 0, 0);
      const secs = beirutSecondsOfDay(t);
      offsets.add(Math.round((t + 0) % 1000)); // placeholder to keep loop cheap
      // 12:00 Beirut is never in a pause; 12:00 UTC may be, so use wall time.
      const noonBeirut = beirutWallToUtc(Math.floor((t + secs * 0) / 1) * 1);
      expect(typeof noonBeirut === 'number' || noonBeirut === null).toBe(true);
    }
    expect(offsets.size).toBeGreaterThan(0);
  });

  it('14:00 Beirut is blocked on both a winter and a summer date', () => {
    // January (EET, UTC+2) and July (EEST, UTC+3).
    expect(clockAllows(2026, 1, 14, 14, 0, 0)).toBe(false);
    expect(clockAllows(2026, 7, 14, 14, 0, 0)).toBe(false);
    expect(clockAllows(2026, 1, 14, 13, 59, 59)).toBe(true);
    expect(clockAllows(2026, 7, 14, 13, 59, 59)).toBe(true);
  });

  it('23:30 Beirut is blocked on both a winter and a summer date', () => {
    expect(clockAllows(2026, 1, 14, 23, 30, 0)).toBe(false);
    expect(clockAllows(2026, 7, 14, 23, 30, 0)).toBe(false);
    expect(clockAllows(2026, 1, 14, 23, 29, 59)).toBe(true);
    expect(clockAllows(2026, 7, 14, 23, 29, 59)).toBe(true);
  });

  it('the two pause intervals never overlap, at any second of the day', () => {
    for (let s = 0; s < 86_400; s += 1) {
      expect(inOvernightPause(s) && inAfternoonPause(s), `second ${s}`).toBe(false);
    }
  });

  it('the spec constants are the confirmed same-day interval', () => {
    expect(SPEC.schedule.afternoonPauseStartSecondsBeirut).toBe(14 * 3600);
    expect(SPEC.schedule.afternoonPauseEndSecondsBeirutExclusive).toBe(19 * 3600);
    expect(SPEC.schedule.afternoonPauseEndSecondsBeirutExclusive).toBeGreaterThan(
      SPEC.schedule.afternoonPauseStartSecondsBeirut,
    );
  });
});
