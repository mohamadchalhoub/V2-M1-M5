/**
 * The trading schedule of `xauusd-m1-m5-rsi-threshold-v2` (§9).
 *
 * Split deliberately into a **clock-only** part and an **externally-gated**
 * part:
 *
 * - `evaluateClockSchedule()` depends on nothing but a UTC instant, so every
 *   boundary (00:59:59 vs 01:00:00, 13:59:59 vs 14:00:00, 18:59:59 vs
 *   19:00:00, 23:29:59 vs 23:30:00, Friday 22:59:59 vs 23:00:00, and the
 *   Beirut DST transitions) is exhaustively testable without a broker, a
 *   database or a fake environment (§15.5).
 * - `evaluateEntryEligibility()` combines that with the live facts only the
 *   runtime knows — whether the broker session is confirmed open, whether
 *   data is fresh, whether recovery finished, whether some other block is in
 *   force.
 *
 * ## The two daily pauses
 *
 * §9.1 blocks new entries during BOTH intervals, every day, on BOTH
 * timeframes:
 *
 *   overnight   23:30 inclusive -> 01:00 exclusive   (wraps midnight)
 *   afternoon   14:00 inclusive -> 19:00 exclusive   (same day, no wrap)
 *
 * The afternoon interval's same-day reading was confirmed explicitly by the
 * user. The specification's earlier "19:00 exclusive the following day"
 * wording would describe a 29-hour block that overlaps its own next
 * occurrence, leaving almost no eligible time at all; it is not what was
 * intended and is not implemented.
 *
 * The former 04:00–12:00 restriction remains removed.
 *
 * Neither pause closes anything. §9.1: observation, rearming, loss-lock
 * processing, reconciliation and protection all continue during a pause, and
 * signals that occur inside one are skipped and consumed — never queued for
 * 01:00 or 19:00.
 *
 * Nothing here hardcodes a weekend reopening time. Per §9.4 the application
 * resumes only on a CONFIRMED open broker session, so `brokerSessionOpen` is
 * a required input and `null` (unknown) blocks.
 */
import { SPEC } from './spec';
import {
  beirutDayOfWeek,
  beirutLabel,
  beirutSecondsOfDay,
  beirutWallToUtc,
  FRIDAY,
  nextBeirutTimeAt,
  utcToBeirutWallMs,
} from './time';

const DAY_MS = 86_400_000;

export type ClockBlockReason =
  /** §9.1 — 23:30 inclusive to 01:00 exclusive, every day. */
  | 'OVERNIGHT_PAUSE'
  /** §9.1 — 14:00 inclusive to 19:00 exclusive, same day, every day. */
  | 'AFTERNOON_PAUSE'
  /** §9.2 — Friday, at or after 23:00, through confirmed reopening. */
  | 'FRIDAY_ENTRY_CUTOFF';

export interface ClockScheduleState {
  /** True when the clock alone permits entries. Other gates still apply. */
  clockAllowsEntries: boolean;
  blockReason: ClockBlockReason | null;
  detail: string;

  inOvernightPause: boolean;
  inAfternoonPause: boolean;

  /** True while this instant lies in the Friday-cutoff-to-reopening window. */
  inWeekendWindow: boolean;
  /** True once Friday liquidation should be running (§9.3). */
  fridayLiquidationDue: boolean;
  /** UTC instant of the Friday 23:30 deadline this instant is governed by, if any. */
  fridayDeadlineT: number | null;
  /** True when the Friday 23:30 deadline has passed inside the weekend window. */
  fridayDeadlinePassed: boolean;

  /** Next UTC instant at which the clock alone would permit entries, if known. */
  nextClockEligibleT: number | null;

  beirutSecondsOfDay: number;
  beirutDayOfWeek: number;
  beirutLabel: string;
}

/**
 * The outer bound of the weekend window: Friday 23:00 Beirut through the
 * following Monday 00:00 Beirut. This is NOT a claim about when the broker
 * reopens — it is the span during which the schedule refuses to assume the
 * market is available and insists on positive confirmation instead. A broker
 * that reopens on Sunday evening is therefore tradable on Sunday evening
 * (subject to both daily pauses), which is exactly what §9.4 requires and
 * what a hardcoded "Sunday 00:00" would have broken.
 */
function weekendWindowBounds(utcMs: number): { start: number; end: number } | null {
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

/** §9.1 — overnight pause, wrapping midnight. */
export function inOvernightPause(secondsOfDay: number): boolean {
  const s = SPEC.schedule;
  return secondsOfDay >= s.overnightPauseStartSecondsBeirut || secondsOfDay < s.overnightPauseEndSecondsBeirutExclusive;
}

/** §9.1 — afternoon pause, same day, does not wrap. */
export function inAfternoonPause(secondsOfDay: number): boolean {
  const s = SPEC.schedule;
  return secondsOfDay >= s.afternoonPauseStartSecondsBeirut && secondsOfDay < s.afternoonPauseEndSecondsBeirutExclusive;
}

export function evaluateClockSchedule(utcMs: number): ClockScheduleState {
  const secs = beirutSecondsOfDay(utcMs);
  const dow = beirutDayOfWeek(utcMs);
  const s = SPEC.schedule;

  const overnight = inOvernightPause(secs);
  const afternoon = inAfternoonPause(secs);
  const fridayCutoffReached = dow === FRIDAY && secs >= s.fridayEntryCutoffSecondsBeirut;

  const weekend = weekendWindowBounds(utcMs);
  const inWeekendWindow = weekend !== null;

  let fridayDeadlineT: number | null = null;
  if (weekend) {
    const wallDayStart = Math.floor(utcToBeirutWallMs(weekend.start) / DAY_MS) * DAY_MS;
    fridayDeadlineT = beirutWallToUtc(wallDayStart + s.fridayClosureDeadlineSecondsBeirut * 1000);
  } else if (dow === FRIDAY) {
    const wallDayStart = Math.floor(utcToBeirutWallMs(utcMs) / DAY_MS) * DAY_MS;
    fridayDeadlineT = beirutWallToUtc(wallDayStart + s.fridayClosureDeadlineSecondsBeirut * 1000);
  }

  const fridayLiquidationDue = fridayCutoffReached || inWeekendWindow;
  const fridayDeadlinePassed =
    fridayDeadlineT !== null && utcMs >= fridayDeadlineT && (inWeekendWindow || fridayCutoffReached);

  // Precedence when several blocks apply at once is about what the operator
  // most needs to see, not about which is "stronger" — entries are blocked
  // either way. Friday's cutoff is reported first because it is the
  // weekend-scoped block and it is what matters at 23:35 on a Friday; the
  // overnight pause is reported ahead of the afternoon one because the two
  // never overlap, so the ordering between them only ever settles ties that
  // cannot occur.
  let blockReason: ClockBlockReason | null = null;
  let detail: string;
  if (fridayCutoffReached || inWeekendWindow) {
    blockReason = 'FRIDAY_ENTRY_CUTOFF';
    detail =
      inWeekendWindow && !fridayCutoffReached
        ? 'Weekend: new entries stay disabled after the Friday 23:00 Beirut cutoff until the broker session is confirmed open again.'
        : 'Friday entry cutoff reached (23:00 Beirut) — no new entries; liquidation of owned exposure must complete before 23:30.';
  } else if (overnight) {
    blockReason = 'OVERNIGHT_PAUSE';
    detail =
      'Overnight entry pause, 23:30–01:00 Beirut. Open positions are unaffected; observation, rearming, ' +
      'loss-lock processing, protection and reconciliation continue.';
  } else if (afternoon) {
    blockReason = 'AFTERNOON_PAUSE';
    detail =
      'Afternoon entry pause, 14:00–19:00 Beirut. Open positions are unaffected; observation, rearming, ' +
      'loss-lock processing, protection and reconciliation continue.';
  } else {
    detail = 'Clock permits new entries.';
  }

  return {
    clockAllowsEntries: blockReason === null,
    blockReason,
    detail,
    inOvernightPause: overnight,
    inAfternoonPause: afternoon,
    inWeekendWindow,
    fridayLiquidationDue,
    fridayDeadlineT,
    fridayDeadlinePassed,
    nextClockEligibleT: nextClockEligibleInstant(utcMs, blockReason),
    beirutSecondsOfDay: secs,
    beirutDayOfWeek: dow,
    beirutLabel: beirutLabel(utcMs),
  };
}

/**
 * The next instant the CLOCK alone would allow entries (§12 — "Show the next
 * known eligibility time").
 *
 * Returns null inside the weekend window: §9.4 forbids predicting the
 * reopening, and a confident timestamp there would be exactly the false
 * claim the specification warns against. The dashboard renders that null as
 * "awaiting confirmed broker reopening".
 */
function nextClockEligibleInstant(utcMs: number, blockReason: ClockBlockReason | null): number | null {
  if (blockReason === null) return utcMs;
  if (blockReason === 'FRIDAY_ENTRY_CUTOFF') return null;
  const s = SPEC.schedule;
  const target =
    blockReason === 'OVERNIGHT_PAUSE' ? s.overnightPauseEndSecondsBeirutExclusive : s.afternoonPauseEndSecondsBeirutExclusive;
  const candidate = nextBeirutTimeAt(utcMs, target);
  if (candidate === null) return null;
  // The end of one pause can land inside the other only if the two were ever
  // made adjacent; they are not, but re-evaluating keeps this honest if the
  // constants change.
  const at = evaluateClockSchedule(candidate);
  return at.clockAllowsEntries ? candidate : at.nextClockEligibleT;
}

/** Live facts the clock cannot know (§9.4, §12). */
export interface RuntimeGates {
  /** §9.4 — null means unknown, which blocks. Never assume a session is open. */
  readonly brokerSessionOpen: boolean | null;
  /** Market data fresh enough to act on. */
  readonly dataFresh: boolean;
  /** Startup/reconnect reconciliation has finished (§10). */
  readonly recoveryComplete: boolean;
  /** Operator kill switch or pause control (§7). */
  readonly killSwitchEngaged: boolean;
  /** Risk, permission or maintenance blocks (§7, §8). */
  readonly executionBlockers: readonly string[];
}

export type EntryBlockReason = ClockBlockReason | 'AWAITING_BROKER_REOPENING' | 'DATA_NOT_FRESH' | 'RECOVERY_INCOMPLETE' | 'KILL_SWITCH' | 'EXECUTION_BLOCKED';

export interface EntryEligibility {
  readonly eligible: boolean;
  readonly reason: EntryBlockReason | null;
  readonly detail: string;
  readonly clock: ClockScheduleState;
}

export function evaluateEntryEligibility(utcMs: number, gates: RuntimeGates): EntryEligibility {
  const clock = evaluateClockSchedule(utcMs);

  if (!clock.clockAllowsEntries) {
    return { eligible: false, reason: clock.blockReason, detail: clock.detail, clock };
  }
  if (gates.killSwitchEngaged) {
    return {
      eligible: false,
      reason: 'KILL_SWITCH',
      detail: 'Kill switch engaged — new entries blocked. Reconciliation and protective management continue.',
      clock,
    };
  }
  if (gates.brokerSessionOpen !== true) {
    return {
      eligible: false,
      reason: 'AWAITING_BROKER_REOPENING',
      detail:
        gates.brokerSessionOpen === null
          ? 'Awaiting confirmed broker reopening — session state unknown, which blocks rather than permits.'
          : 'Broker session is not open.',
      clock,
    };
  }
  if (!gates.recoveryComplete) {
    return { eligible: false, reason: 'RECOVERY_INCOMPLETE', detail: 'Startup/reconnect recovery has not finished.', clock };
  }
  if (!gates.dataFresh) {
    return { eligible: false, reason: 'DATA_NOT_FRESH', detail: 'Market data is not fresh enough to act on.', clock };
  }
  if (gates.executionBlockers.length > 0) {
    return {
      eligible: false,
      reason: 'EXECUTION_BLOCKED',
      detail: `Execution blocked: ${gates.executionBlockers.join('; ')}`,
      clock,
    };
  }
  return {
    eligible: true,
    reason: null,
    detail: 'Eligible, subject to per-candidate occupancy, post-loss lock, risk and quote checks.',
    clock,
  };
}
