/**
 * Schedule boundaries for `xauusd-m1-rsi-retest-extremes-v1` (spec §9).
 *
 * Every instant below is written as an explicit UTC string with its Beirut
 * wall-clock meaning in the test name, and those meanings were verified
 * against the runtime's own IANA database before being written down — so a
 * failure here means the schedule logic changed, not that the test guessed
 * an offset. Beirut runs UTC+3 in summer (EEST) and UTC+2 in winter (EET).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateClockSchedule,
  evaluateEntryEligibility,
  evaluateLiquidationPhase,
  nextClockEligibleAt,
  nextFridayDeadlineAt,
} from '../../src/xauusd-rsi/schedule';

const at = (iso: string) => new Date(iso).getTime();

/** All non-clock gates satisfied, so a case isolates the clock. */
const openMarket = {
  brokerSessionOpen: true as boolean | null,
  dataFresh: true,
  recoveryComplete: true,
  otherBlock: null as string | null,
};

describe('Daily entry pause, 23:30–01:00 Beirut (spec §9.1)', () => {
  it('allows entries at Thursday 23:29:59 Beirut', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-24T20:29:59Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(true);
  });

  it('blocks entries at Thursday 23:30:00 Beirut, the inclusive start', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-24T20:30:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(false);
    expect(r.blockReason).toBe('DAILY_PAUSE');
  });

  it('still blocks at 00:59:59 Beirut', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-24T21:59:59Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(false);
    expect(r.blockReason).toBe('DAILY_PAUSE');
  });

  it('allows entries again at 01:00:00 Beirut, the exclusive end', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-24T22:00:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(true);
  });

  it('reports 01:00 Beirut as the next eligible time while paused', () => {
    const next = nextClockEligibleAt(at('2026-09-24T20:45:00Z'));
    expect(next).toBe(at('2026-09-24T22:00:00Z'));
  });

  it('does not force a position closed at either boundary — the pause governs ENTRIES only', () => {
    // The clock state exposes no closure obligation on an ordinary weekday.
    const clock = evaluateClockSchedule(at('2026-09-24T20:30:00Z'));
    expect(clock.fridayLiquidationDue).toBe(false);
    const phase = evaluateLiquidationPhase({ utcMs: at('2026-09-24T20:30:00Z'), ownedExposureFlat: false });
    expect(phase.phase).toBe('NOT_DUE');
  });

  it('removes the old 04:00–12:00 window: 15:00 Beirut on a weekday is eligible', () => {
    // 12:00Z = 15:00 Beirut (UTC+3), well outside the retired window.
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-23T12:00:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(true);
  });

  it('and 06:00 Beirut, inside the old window, is equally eligible', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-23T03:00:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(true);
  });
});

describe('Friday entry cutoff at 23:00 Beirut (spec §9.2)', () => {
  it('allows entries at Friday 22:59:59 Beirut', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-25T19:59:59Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(true);
  });

  it('blocks entries at Friday 23:00:00 Beirut exactly', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-25T20:00:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(false);
    expect(r.blockReason).toBe('FRIDAY_ENTRY_CUTOFF');
  });

  it('reports no known next eligible time after the cutoff — never an invented reopening', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-25T20:00:00Z'), ...openMarket });
    expect(r.nextEligibleAtT).toBeNull();
    expect(r.nextEligibleLabel).toBe('awaiting confirmed broker reopening');
  });
});

describe('Friday liquidation (spec §9.3)', () => {
  it('becomes due immediately at the 23:00 cutoff, not at 23:29', () => {
    const phase = evaluateLiquidationPhase({ utcMs: at('2026-09-25T20:00:00Z'), ownedExposureFlat: false });
    expect(phase.phase).toBe('IN_PROGRESS');
  });

  it('is not due at Friday 22:59:59', () => {
    const phase = evaluateLiquidationPhase({ utcMs: at('2026-09-25T19:59:59Z'), ownedExposureFlat: false });
    expect(phase.phase).toBe('NOT_DUE');
  });

  it('reports CONFIRMED_FLAT only on evidence that owned exposure is gone', () => {
    const phase = evaluateLiquidationPhase({ utcMs: at('2026-09-25T20:10:00Z'), ownedExposureFlat: true });
    expect(phase.phase).toBe('CONFIRMED_FLAT');
  });

  it('reports DEADLINE_MISSED once 23:30 passes with exposure remaining', () => {
    const phase = evaluateLiquidationPhase({ utcMs: at('2026-09-25T20:30:00Z'), ownedExposureFlat: false });
    expect(phase.phase).toBe('DEADLINE_MISSED');
  });

  it('does not report DEADLINE_MISSED when exposure was confirmed flat in time', () => {
    const phase = evaluateLiquidationPhase({ utcMs: at('2026-09-25T20:30:00Z'), ownedExposureFlat: true });
    expect(phase.phase).toBe('CONFIRMED_FLAT');
  });

  it('exposes the Friday 23:30 deadline instant during the cutoff window', () => {
    const clock = evaluateClockSchedule(at('2026-09-25T20:05:00Z'));
    expect(clock.fridayDeadlineT).toBe(at('2026-09-25T20:30:00Z'));
  });

  it('still reports liquidation due after a weekend restart with exposure remaining', () => {
    // Saturday 12:00 Beirut — the process may have been off since Friday.
    const phase = evaluateLiquidationPhase({ utcMs: at('2026-09-26T09:00:00Z'), ownedExposureFlat: false });
    expect(phase.phase).toBe('DEADLINE_MISSED');
  });
});

describe('Weekend pause and reopening (spec §9.4)', () => {
  it('blocks all day Saturday', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-26T09:00:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(false);
    expect(r.blockReason).toBe('FRIDAY_ENTRY_CUTOFF');
  });

  it('does not hardcode Sunday 00:00 — Sunday stays blocked on the clock alone', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-27T09:00:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(false);
  });

  it('blocks when broker session availability is unknown, and says so', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-23T12:00:00Z'), ...openMarket, brokerSessionOpen: null });
    expect(r.entriesAllowed).toBe(false);
    expect(r.blockReason).toBe('BROKER_SESSION_NOT_CONFIRMED_OPEN');
    expect(r.detail).toMatch(/could not be established/);
  });

  it('blocks when the broker session is confirmed closed', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-23T12:00:00Z'), ...openMarket, brokerSessionOpen: false });
    expect(r.blockReason).toBe('BROKER_SESSION_NOT_CONFIRMED_OPEN');
  });

  it('keeps waiting until 01:00 when the market reopens during the daily pause', () => {
    // Monday 00:15 Beirut, broker confirmed open: the daily pause still wins.
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-27T21:15:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(false);
    expect(r.blockReason).toBe('DAILY_PAUSE');
    expect(r.nextEligibleAtT).toBe(at('2026-09-27T22:00:00Z'));
  });

  it('resumes on Monday morning once the session is confirmed open', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-28T07:00:00Z'), ...openMarket });
    expect(r.entriesAllowed).toBe(true);
  });
});

describe('Non-clock gates (spec §9.4)', () => {
  it('blocks on stale data', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-23T12:00:00Z'), ...openMarket, dataFresh: false });
    expect(r.blockReason).toBe('DATA_NOT_FRESH');
  });

  it('blocks until recovery/reconciliation has completed', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-23T12:00:00Z'), ...openMarket, recoveryComplete: false });
    expect(r.blockReason).toBe('RECOVERY_INCOMPLETE');
  });

  it('blocks on an independent risk or maintenance block, preserving its description', () => {
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-23T12:00:00Z'), ...openMarket, otherBlock: 'kill switch active' });
    expect(r.blockReason).toBe('OTHER_BLOCK');
    expect(r.detail).toBe('kill switch active');
  });

  it('reports the market closure ahead of stale data when both are true', () => {
    // An operator asking "why no trade?" on a Saturday should be told the
    // market is shut, not that the quote is old because the market is shut.
    const r = evaluateEntryEligibility({ utcMs: at('2026-09-26T09:00:00Z'), ...openMarket, dataFresh: false });
    expect(r.blockReason).toBe('FRIDAY_ENTRY_CUTOFF');
  });
});

describe('Beirut daylight-saving transitions', () => {
  it('handles the pause boundary in winter (UTC+2): 23:30 Beirut is 21:30 UTC', () => {
    // Tuesday 2026-10-27, after the autumn transition, so Beirut is UTC+2.
    // A weekday is required here: a Sunday would be blocked by the weekend
    // window instead, which would hide the boundary this case is about.
    const before = evaluateEntryEligibility({ utcMs: at('2026-10-27T21:29:59Z'), ...openMarket });
    const after = evaluateEntryEligibility({ utcMs: at('2026-10-27T21:30:00Z'), ...openMarket });
    expect(before.entriesAllowed).toBe(true);
    expect(after.blockReason).toBe('DAILY_PAUSE');
  });

  it('handles the Friday cutoff in winter: 23:00 Beirut is 21:00 UTC', () => {
    // 2026-12-25 is a Friday, Beirut on UTC+2.
    const before = evaluateEntryEligibility({ utcMs: at('2026-12-25T20:59:59Z'), ...openMarket });
    const after = evaluateEntryEligibility({ utcMs: at('2026-12-25T21:00:00Z'), ...openMarket });
    expect(before.entriesAllowed).toBe(true);
    expect(after.blockReason).toBe('FRIDAY_ENTRY_CUTOFF');
  });

  it('computes the winter Friday deadline as 21:30 UTC', () => {
    const deadline = nextFridayDeadlineAt(at('2026-12-25T12:00:00Z'));
    expect(deadline).toBe(at('2026-12-25T21:30:00Z'));
  });

  it('computes the summer Friday deadline as 20:30 UTC', () => {
    const deadline = nextFridayDeadlineAt(at('2026-09-25T12:00:00Z'));
    expect(deadline).toBe(at('2026-09-25T20:30:00Z'));
  });
});
