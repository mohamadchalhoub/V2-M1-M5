/**
 * The dashboard's view model (§12).
 *
 * Pure: it turns runtime state into exactly what the operator should see, and
 * nothing here touches a database or a broker. That matters because two of
 * §12's requirements are really labelling rules, and a labelling rule is only
 * worth having if it is tested:
 *
 * 1. **98.5 and 1.5 are never presented as entry thresholds.** They have no
 *    standalone entry meaning at all (§3.4); they survive only as post-loss
 *    unlock conditions. A dashboard that lists them beside 91 and 8.9 would
 *    teach the operator a rule this strategy does not implement.
 * 2. **Old peak/trough/retest/extreme state is never displayed as active
 *    behaviour.** Those setups are gone, and showing their remnants would
 *    misrepresent what the running strategy does.
 *
 * The schedule states are likewise distinct values rather than a single
 * "blocked" flag, because "paused until 19:00" and "awaiting confirmed broker
 * reopening" call for completely different operator responses.
 */
import { describeArming, type CrossingState } from './crossing';
import { describeHealth, type EngineHealth, type EngineState } from './engine';
import { describeLockScope, describeUnlockCondition } from './locks';
import { describeReadiness, type ReadinessVerdict } from './mt5-readiness';
import { describeOwnership } from './ownership';
import type { EntryEligibility } from './schedule';
import {
  V2_MAGIC_M1,
  V2_MAGIC_M5,
  V2_OBSERVATION_CADENCE_TOLERANCE_MS,
  V2_SL_USD,
  V2_TP_USD,
} from './safety-constants';
import {
  DIRECTIONS,
  SPEC,
  SPEC_HASH,
  TIMEFRAMES,
  XAUUSD_M1M5_STRATEGY_VERSION,
  type Direction,
  type Timeframe,
} from './spec';

/**
 * The schedule states §12 requires be shown distinctly. Deliberately an
 * enumeration rather than a boolean plus a message: the dashboard renders
 * each differently, and an operator needs to distinguish "wait four hours"
 * from "the market is shut" from "we missed the deadline and exposure
 * remains".
 */
export type ScheduleDisplayState =
  | 'ELIGIBLE'
  | 'OVERNIGHT_PAUSE'
  | 'AFTERNOON_PAUSE'
  | 'FRIDAY_CUTOFF'
  | 'FRIDAY_LIQUIDATION_UNDERWAY'
  | 'LIQUIDATION_CONFIRMED'
  | 'DEADLINE_MISSED'
  | 'WEEKEND_OR_SESSION_CLOSED'
  | 'OTHER_EXECUTION_BLOCKER';

export interface LockDisplay {
  readonly timeframe: Timeframe;
  readonly direction: Direction;
  readonly state: 'ACTIVE' | 'INACTIVE';
  /** The trade that caused it, or null if this direction has never lost. */
  readonly causingTrade: string | null;
  readonly netRealizedLoss: number | null;
  readonly activatedAt: string | null;
  /** Current RSI of the OWNING timeframe — never the other one. */
  readonly currentRsi: number | null;
  /** The exact wording §12 requires. Always an UNLOCK condition. */
  readonly unlockCondition: string;
  readonly lastUnlock: string | null;
  readonly scope: string;
}

export interface TimeframeDisplay {
  readonly timeframe: Timeframe;
  readonly health: EngineHealth;
  readonly sellArming: string;
  readonly buyArming: string;
  readonly occupancy: string;
  readonly magicNumber: number;
}

export interface DashboardView {
  readonly strategyVersion: string;
  readonly specHash: string;
  readonly buildCommit: string | null;
  readonly accountLabel: string | null;
  readonly executionMode: string;

  /** Only the two genuine entry thresholds. 98.5 and 1.5 are NOT here. */
  readonly entryThresholds: { readonly sell: number; readonly buy: number };
  readonly brackets: { readonly takeProfitUsd: number; readonly stopLossUsd: number };
  readonly indicator: string;

  readonly timeframes: readonly TimeframeDisplay[];
  /** All four, always — an INACTIVE lock is still shown (§12). */
  readonly locks: readonly LockDisplay[];

  readonly schedule: {
    readonly state: ScheduleDisplayState;
    readonly detail: string;
    /** Null renders as "awaiting confirmed broker reopening" (§9.4). */
    readonly nextEligibleT: number | null;
    readonly fridayDeadlineT: number | null;
  };

  readonly mt5: {
    readonly ready: boolean;
    readonly summary: string;
    readonly blockers: readonly { code: string; origin: string; detail: string }[];
    readonly hedgingSupported: boolean | null;
  };

  readonly observationLimitations: readonly string[];
}

export interface LockStateInput {
  readonly timeframe: Timeframe;
  readonly direction: Direction;
  readonly active: boolean;
  readonly losingPositionId: string | null;
  readonly netRealized: number | null;
  readonly activatedAt: Date | null;
  readonly unlockCondition: string | null;
  readonly unlockRsi: number | null;
  readonly unlockedAt: Date | null;
}

export interface BuildViewInput {
  readonly buildCommit: string | null;
  readonly accountLabel: string | null;
  readonly executionMode: string;
  readonly engines: Readonly<Record<Timeframe, EngineState>>;
  readonly crossings: Readonly<Record<Timeframe, CrossingState>>;
  readonly occupancy: Readonly<Record<Timeframe, { magicNumber: number | null; detail: string } | null>>;
  readonly locks: readonly LockStateInput[];
  readonly eligibility: EntryEligibility;
  readonly readiness: ReadinessVerdict;
  readonly liquidation: { readonly underway: boolean; readonly confirmedFlat: boolean; readonly deadlineMissed: boolean };
  /** Honest disclosure of anything degrading observation (§10, §12). */
  readonly observationLimitations: readonly string[];
}

export function buildDashboardView(input: BuildViewInput): DashboardView {
  const timeframes = TIMEFRAMES.map<TimeframeDisplay>((tf) => {
    const held = input.occupancy[tf];
    return {
      timeframe: tf,
      health: describeHealth(input.engines[tf], V2_OBSERVATION_CADENCE_TOLERANCE_MS),
      sellArming: describeArming(input.crossings[tf], 'SELL'),
      buyArming: describeArming(input.crossings[tf], 'BUY'),
      occupancy: held
        ? `Occupied — ${describeOwnership(held.magicNumber)}. ${held.detail}`
        : 'Free — no active, pending or uncertain exposure on this timeframe.',
      magicNumber: tf === 'M1' ? V2_MAGIC_M1 : V2_MAGIC_M5,
    };
  });

  // All four locks, always, in a stable order. An INACTIVE lock still tells
  // the operator the direction is currently eligible, which is information.
  const locks: LockDisplay[] = [];
  for (const tf of TIMEFRAMES) {
    for (const dir of DIRECTIONS) {
      const row = input.locks.find((l) => l.timeframe === tf && l.direction === dir);
      locks.push({
        timeframe: tf,
        direction: dir,
        state: row?.active ? 'ACTIVE' : 'INACTIVE',
        causingTrade: row?.losingPositionId ?? null,
        netRealizedLoss: row?.netRealized ?? null,
        activatedAt: row?.activatedAt?.toISOString() ?? null,
        // The OWNING timeframe's RSI. Reading the other one here would be a
        // subtle lie that makes an unlock look imminent when it is not.
        currentRsi: describeHealth(input.engines[tf], V2_OBSERVATION_CADENCE_TOLERANCE_MS).rsi,
        unlockCondition: describeUnlockCondition(dir),
        lastUnlock:
          row?.unlockedAt && row.unlockCondition
            ? `Released ${row.unlockedAt.toISOString()} on ${row.unlockCondition} at RSI ${row.unlockRsi}.`
            : null,
        scope: describeLockScope(tf, dir),
      });
    }
  }

  return {
    strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
    specHash: SPEC_HASH,
    buildCommit: input.buildCommit,
    accountLabel: input.accountLabel,
    executionMode: input.executionMode,

    entryThresholds: { sell: SPEC.thresholds.sellCross, buy: SPEC.thresholds.buyCross },
    brackets: { takeProfitUsd: V2_TP_USD, stopLossUsd: V2_SL_USD },
    indicator: `RSI(${SPEC.rsi.period}), ${SPEC.rsi.appliedPrice}, ${SPEC.rsi.smoothing} smoothing, computed independently per timeframe`,

    timeframes,
    locks,

    schedule: {
      state: scheduleDisplayState(input),
      detail: input.eligibility.detail,
      nextEligibleT: input.eligibility.clock.nextClockEligibleT,
      fridayDeadlineT: input.eligibility.clock.fridayDeadlineT,
    },

    mt5: {
      ready: input.readiness.ready,
      summary: describeReadiness(input.readiness),
      blockers: input.readiness.blockers.map((b) => ({ code: b.code, origin: b.origin, detail: b.detail })),
      hedgingSupported: input.readiness.hedgingSupported,
    },

    observationLimitations: input.observationLimitations,
  };
}

function scheduleDisplayState(input: BuildViewInput): ScheduleDisplayState {
  // Liquidation outcomes are reported ahead of the ordinary clock states:
  // at 23:40 on a Friday, "deadline missed, exposure remains" is what the
  // operator must see, not "weekend".
  if (input.liquidation.deadlineMissed) return 'DEADLINE_MISSED';
  if (input.liquidation.underway) return 'FRIDAY_LIQUIDATION_UNDERWAY';

  const clock = input.eligibility.clock;
  if (clock.blockReason === 'FRIDAY_ENTRY_CUTOFF') {
    if (input.liquidation.confirmedFlat) return 'LIQUIDATION_CONFIRMED';
    return clock.inWeekendWindow && !clock.fridayLiquidationDue ? 'WEEKEND_OR_SESSION_CLOSED' : 'FRIDAY_CUTOFF';
  }
  if (clock.blockReason === 'OVERNIGHT_PAUSE') return 'OVERNIGHT_PAUSE';
  if (clock.blockReason === 'AFTERNOON_PAUSE') return 'AFTERNOON_PAUSE';

  if (input.eligibility.reason === 'AWAITING_BROKER_REOPENING') return 'WEEKEND_OR_SESSION_CLOSED';
  if (input.eligibility.reason !== null) return 'OTHER_EXECUTION_BLOCKER';
  return 'ELIGIBLE';
}

/**
 * Human rendering of the next eligibility time (§9.4, §12).
 *
 * A null instant is not "unknown, probably soon" — inside the weekend window
 * it means the application refuses to predict a reopening it has not been
 * told about, and saying so plainly is the honest render.
 */
export function describeNextEligibility(nextEligibleT: number | null): string {
  if (nextEligibleT === null) return 'Awaiting confirmed broker reopening.';
  return `Next eligible at ${new Date(nextEligibleT).toISOString()}, subject to the other gates.`;
}
