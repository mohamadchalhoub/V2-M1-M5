/**
 * The trading schedule of `xauusd-m1-rsi-retest-extremes-v1` (spec §9).
 *
 * Supersedes every earlier schedule in this application; the old
 * 04:00–12:00 Beirut entry window is gone.
 *
 * Split deliberately into a **clock-only** part and an **externally-gated**
 * part:
 *
 * - `evaluateClockSchedule()` depends on nothing but a UTC instant, so every
 *   boundary (23:29:59 vs 23:30:00, 00:59:59 vs 01:00:00, Friday 22:59:59
 *   vs 23:00:00, and the Beirut DST transitions) is exhaustively testable
 *   without a broker, a database or a fake environment.
 * - `evaluateEntryEligibility()` combines that with the live facts only the
 *   runtime knows — whether the broker session is confirmed open, whether
 *   data is fresh, whether recovery finished, whether some other block is
 *   in force.
 *
 * Nothing here hardcodes a weekend reopening time. Per spec §9.4 the
 * application resumes only on a CONFIRMED open broker session, so
 * `brokerSessionOpen` is a required input and `null` (unknown) blocks.
 */
import { SPEC } from './spec';
import { beirutDayOfWeek, beirutLabel, beirutSecondsOfDay, beirutWallToUtc, FRIDAY, nextBeirutTimeAt, utcToBeirutWallMs } from './time';

const DAY_MS = 86_400_000;

export type ClockBlockReason =
  /** Spec §9.1 — 23:30 inclusive to 01:00 exclusive, every day. */
  | 'DAILY_PAUSE'
  /** Spec §9.2 — Friday, at or after 23:00. */
  | 'FRIDAY_ENTRY_CUTOFF';

export interface ClockScheduleState {
  /** True when the clock alone permits entries. Other gates still apply. */
  clockAllowsEntries: boolean;
  blockReason: ClockBlockReason | null;
  detail: string;

  /** True while this instant lies in the Friday-cutoff-to-reopening window. */
  inWeekendWindow: boolean;
  /** True once Friday liquidation should be running (spec §9.3). */
  fridayLiquidationDue: boolean;
  /** UTC instant of the Friday 23:30 deadline this instant is governed by, if any. */
  fridayDeadlineT: number | null;
  /** True when the Friday 23:30 deadline has passed inside the weekend window. */
  fridayDeadlinePassed: boolean;

  beirutSecondsOfDay: number;
  beirutDayOfWeek: number;
  beirutLabel: string;
}

/**
 * The outer bound of the weekend window: Friday 23:00 Beirut through the
 * following Monday 00:00 Beirut. This is NOT a claim about when the broker
 * reopens — it is the span during which the schedule refuses to assume the
 * market is available and insists on positive confirmation instead. A
 * broker that reopens on Sunday evening is therefore tradable on Sunday
 * evening (subject to the daily pause), which is exactly what spec §9.4
 * requires and what a hardcoded "Sunday 00:00" would have broken.
 */
function weekendWindowBounds(utcMs: number): { start: number; end: number } | null {
  // Walk back to the most recent Friday (Beirut) within the last 3 days.
  for (let back = 0; back <= 3; back += 1) {
    const probe = utcMs - back * DAY_MS;
    if (beirutDayOfWeek(probe) !== FRIDAY) continue;
    const wallDayStart = Math.floor(utcToBeirutWallMs(probe) / DAY_MS) * DAY_MS;
    const start = beirutWallToUtc(wallDayStart + SPEC.schedule.fridayEntryCutoffSecondsBeirut * 1000);
    const end = beirutWallToUtc(wallDayStart + 3 * DAY_MS); // Monday 00:00 Beirut
    if (start === null || end === null) continue;
    if (utcMs >= start && utcMs < end) return { start, end };
  }
  return null;
}

export function evaluateClockSchedule(utcMs: number): ClockScheduleState {
  const secs = beirutSecondsOfDay(utcMs);
  const dow = beirutDayOfWeek(utcMs);
  const s = SPEC.schedule;

  const inDailyPause = secs >= s.dailyPauseStartSecondsBeirut || secs < s.dailyPauseEndSecondsBeirutExclusive;
  const fridayCutoffReached = dow === FRIDAY && secs >= s.fridayEntryCutoffSecondsBeirut;

  const weekend = weekendWindowBounds(utcMs);
  const inWeekendWindow = weekend !== null;

  // The Friday 23:30 deadline governing this instant: the one belonging to
  // the Friday that opened the current weekend window.
  let fridayDeadlineT: number | null = null;
  if (weekend) {
    const wallDayStart = Math.floor(utcToBeirutWallMs(weekend.start) / DAY_MS) * DAY_MS;
    fridayDeadlineT = beirutWallToUtc(wallDayStart + s.fridayClosureDeadlineSecondsBeirut * 1000);
  } else if (dow === FRIDAY) {
    const wallDayStart = Math.floor(utcToBeirutWallMs(utcMs) / DAY_MS) * DAY_MS;
    fridayDeadlineT = beirutWallToUtc(wallDayStart + s.fridayClosureDeadlineSecondsBeirut * 1000);
  }

  const fridayLiquidationDue = fridayCutoffReached || inWeekendWindow;
  const fridayDeadlinePassed = fridayDeadlineT !== null && utcMs >= fridayDeadlineT && (inWeekendWindow || fridayCutoffReached);

  // Friday's cutoff is reported in preference to the daily pause when both
  // apply, because it is the stricter, weekend-scoped block and it is what
  // the operator needs to see at 23:35 on a Friday.
  let blockReason: ClockBlockReason | null = null;
  let detail: string;
  if (fridayCutoffReached || inWeekendWindow) {
    blockReason = 'FRIDAY_ENTRY_CUTOFF';
    detail = inWeekendWindow && !fridayCutoffReached
      ? 'Weekend: new entries stay disabled after the Friday 23:00 Beirut cutoff until the broker session is confirmed open again.'
      : 'Friday entry cutoff reached (23:00 Beirut) — no new entries; liquidation of owned exposure must complete before 23:30.';
  } else if (inDailyPause) {
    blockReason = 'DAILY_PAUSE';
    detail = 'Daily entry pause, 23:30–01:00 Beirut. Open positions are unaffected; protection and reconciliation continue.';
  } else {
    detail = 'Clock permits new entries.';
  }

  return {
    clockAllowsEntries: blockReason === null,
    blockReason,
    detail,
    inWeekendWindow,
    fridayLiquidationDue,
    fridayDeadlineT,
    fridayDeadlinePassed,
    beirutSecondsOfDay: secs,
    beirutDayOfWeek: dow,
    beirutLabel: beirutLabel(utcMs),
  };
}

/**
 * Earliest UTC instant at which the clock alone would next permit entries.
 *
 * Returns `null` inside the weekend window: the clock genuinely does not
 * know when the broker reopens, and inventing a time would be exactly the
 * hardcoded "Sunday 00:00" the spec forbids. Callers render this as
 * "awaiting confirmed broker reopening".
 */
export function nextClockEligibleAt(utcMs: number): number | null {
  const clock = evaluateClockSchedule(utcMs);
  if (clock.clockAllowsEntries) return utcMs;
  if (clock.inWeekendWindow || clock.blockReason === 'FRIDAY_ENTRY_CUTOFF') return null;
  // Daily pause — it always ends at 01:00 Beirut.
  return nextBeirutTimeAt(utcMs, SPEC.schedule.dailyPauseEndSecondsBeirutExclusive);
}

/** The next Friday 23:30 Beirut deadline strictly after `utcMs`. */
export function nextFridayDeadlineAt(utcMs: number): number | null {
  return nextBeirutTimeAt(utcMs, SPEC.schedule.fridayClosureDeadlineSecondsBeirut, FRIDAY);
}

/** The next Friday 23:00 Beirut entry cutoff strictly after `utcMs`. */
export function nextFridayCutoffAt(utcMs: number): number | null {
  return nextBeirutTimeAt(utcMs, SPEC.schedule.fridayEntryCutoffSecondsBeirut, FRIDAY);
}

export type EntryBlockReason =
  | ClockBlockReason
  | 'BROKER_SESSION_NOT_CONFIRMED_OPEN'
  | 'DATA_NOT_FRESH'
  | 'RECOVERY_INCOMPLETE'
  | 'OTHER_BLOCK';

export interface EntryEligibilityInput {
  utcMs: number;
  /**
   * Whether the broker's XAUUSD session is CONFIRMED open right now.
   * `null` means unknown — which blocks, per spec §9.4 ("If broker session
   * availability cannot be established, remain paused and explain why").
   */
  brokerSessionOpen: boolean | null;
  /** Whether tradable market data is fresh enough to act on. */
  dataFresh: boolean;
  /** Whether startup/reconnect reconciliation has completed. */
  recoveryComplete: boolean;
  /** Any independent risk, maintenance, kill-switch or pause block, with its own description. */
  otherBlock: string | null;
}

export interface EntryEligibility {
  entriesAllowed: boolean;
  blockReason: EntryBlockReason | null;
  detail: string;
  clock: ClockScheduleState;
  /** Next instant entries could become allowed, as far as is knowable. Null = awaiting confirmed broker reopening. */
  nextEligibleAtT: number | null;
  nextEligibleLabel: string;
}

/**
 * The single place that decides whether a new entry may be submitted.
 *
 * Ordered so the reported reason is the most fundamental one: an operator
 * looking at "why didn't it trade?" should see "the market is shut", not
 * "data is stale", when both are true because the market is shut.
 */
export function evaluateEntryEligibility(input: EntryEligibilityInput): EntryEligibility {
  const clock = evaluateClockSchedule(input.utcMs);

  const nextClock = nextClockEligibleAt(input.utcMs);
  const nextEligibleLabel =
    nextClock === null
      ? 'awaiting confirmed broker reopening'
      : nextClock <= input.utcMs
        ? 'now, if all other gates pass'
        : beirutLabel(nextClock);

  const block = (blockReason: EntryBlockReason, detail: string): EntryEligibility => ({
    entriesAllowed: false,
    blockReason,
    detail,
    clock,
    nextEligibleAtT: nextClock,
    nextEligibleLabel,
  });

  if (!clock.clockAllowsEntries) {
    return block(clock.blockReason as ClockBlockReason, clock.detail);
  }
  if (input.brokerSessionOpen !== true) {
    return block(
      'BROKER_SESSION_NOT_CONFIRMED_OPEN',
      input.brokerSessionOpen === null
        ? 'Broker XAUUSD session availability could not be established — staying paused rather than assuming the market is open.'
        : 'Broker XAUUSD session is confirmed closed — no new entries.',
    );
  }
  if (!input.dataFresh) {
    return block('DATA_NOT_FRESH', 'Market data is not fresh enough to act on — no new entries until a current quote is observed.');
  }
  if (!input.recoveryComplete) {
    return block('RECOVERY_INCOMPLETE', 'Startup/reconnect reconciliation has not completed — no new entries until persisted decisions and broker exposure agree.');
  }
  if (input.otherBlock) {
    return block('OTHER_BLOCK', input.otherBlock);
  }

  return {
    entriesAllowed: true,
    blockReason: null,
    detail: 'Eligible for new entries.',
    clock,
    nextEligibleAtT: input.utcMs,
    nextEligibleLabel: 'now',
  };
}

/**
 * Friday-liquidation phase, for the dashboard's required distinct states
 * (spec §11) and for the liquidation worker's own gating.
 *
 * `ownedExposureFlat` must come from BROKER evidence, never from a close
 * request having been submitted (spec §9.3).
 */
export type LiquidationPhase =
  | 'NOT_DUE'
  | 'IN_PROGRESS'
  | 'CONFIRMED_FLAT'
  | 'DEADLINE_MISSED';

export function evaluateLiquidationPhase(params: {
  utcMs: number;
  ownedExposureFlat: boolean;
}): { phase: LiquidationPhase; detail: string; deadlineT: number | null } {
  const clock = evaluateClockSchedule(params.utcMs);
  if (!clock.fridayLiquidationDue) {
    return { phase: 'NOT_DUE', detail: 'Friday liquidation is not due.', deadlineT: clock.fridayDeadlineT };
  }
  if (params.ownedExposureFlat) {
    return {
      phase: 'CONFIRMED_FLAT',
      detail: 'Broker-confirmed: no owned XAUUSD positions or pending orders remain.',
      deadlineT: clock.fridayDeadlineT,
    };
  }
  if (clock.fridayDeadlinePassed) {
    return {
      phase: 'DEADLINE_MISSED',
      detail: 'The Friday 23:30 Beirut closure deadline has passed and owned exposure still remains. This is a critical incident.',
      deadlineT: clock.fridayDeadlineT,
    };
  }
  return {
    phase: 'IN_PROGRESS',
    detail: 'Friday liquidation is running: cancelling owned pending orders and closing owned positions until the broker confirms flat.',
    deadlineT: clock.fridayDeadlineT,
  };
}
