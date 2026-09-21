/**
 * Everything the operator needs to answer "what is this strategy doing, and
 * why is it or isn't it trading right now?" in one read-only payload (§12).
 *
 * Three rules govern what this endpoint is allowed to say:
 *
 * 1. **It never claims health it cannot see.** The observation loop is a
 *    separate process, so its heartbeat is read from a state file and
 *    reported as STALE unless genuinely recent. A dead process's last cycle
 *    is never presented as current — which is exactly the failure that makes
 *    a dashboard worse than no dashboard.
 * 2. **It never claims the account is flat when only owned exposure is.**
 *    Foreign and manual XAUUSD positions are reported in their own section
 *    and never folded into this strategy's totals (§9.3).
 * 3. **It never presents 98.5 or 1.5 as entry thresholds** (§12). That rule
 *    is enforced in `dashboard-view.ts`, which builds the payload and is
 *    tested for it directly.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { buildDashboardView, describeNextEligibility, type LockStateInput } from './dashboard-view';
import { createCrossingState } from './crossing';
import { createEngineState } from './engine';
import { getM1M5ExecutionMode, killSwitchState, stopNewEntriesState, submissionBlockedReason } from './controls';
import { evaluateEntryEligibility } from './schedule';
import { evaluateReadiness, type Mt5PermissionSnapshot } from './mt5-readiness';
import { describeOwnership, extractMagic } from './ownership';
import { heartbeatIsFresh, readWatchState, HEARTBEAT_STALE_AFTER_MS } from './state-store';
import { SPEC_HASH, TIMEFRAMES, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from './spec';
import { V2_MAGIC_NUMBERS } from './safety-constants';

@Controller('xauusd-m1m5')
@UseGuards(DashboardTokenGuard)
export class M1M5DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('dashboard')
  async dashboard() {
    const now = Date.now();
    const state = readWatchState();
    const heartbeatFresh = heartbeatIsFresh(state, now);

    const account = await this.prisma.tradingAccount.findFirst({ orderBy: { createdAt: 'asc' } });
    const accountId = account?.id ?? null;

    // --- Locks, read from the database rather than from the loop's state
    // file. A lock is a durable consequence of a realized loss, and the
    // database is its authority; reading it from a possibly-stale snapshot
    // could show a lock as released when it is not.
    const lockRows = accountId
      ? await this.prisma.xauusdM1M5DirectionalLock.findMany({ where: { accountId } })
      : [];
    const locks: LockStateInput[] = lockRows.map((r) => ({
      timeframe: r.timeframe as Timeframe,
      direction: r.direction as 'SELL' | 'BUY',
      active: r.active,
      losingPositionId: r.losingPositionId,
      netRealized: r.netRealized === null ? null : Number(r.netRealized),
      activatedAt: r.activatedAt,
      unlockCondition: r.unlockCondition,
      unlockRsi: r.unlockRsi === null ? null : Number(r.unlockRsi),
      unlockedAt: r.unlockedAt,
    }));

    // --- Occupancy, likewise from the database: the slot row IS the truth.
    const slotRows = accountId ? await this.prisma.xauusdM1M5SlotLock.findMany({ where: { accountId } }) : [];
    const occupancy: Record<Timeframe, { magicNumber: number | null; detail: string } | null> = {
      M1: null,
      M5: null,
    };
    for (const row of slotRows) {
      const tf = row.timeframe as Timeframe;
      const decision = await this.prisma.xauusdM1M5Decision.findUnique({ where: { id: row.decisionId } });
      occupancy[tf] = {
        magicNumber: decision?.magicNumber ?? null,
        detail: `${row.state} since ${row.claimedAt.toISOString()}${decision?.ticket ? `, ticket ${decision.ticket}` : ''}`,
      };
    }

    // --- MT5 readiness. No snapshot source is wired yet, and that is
    // reported honestly as a blocker rather than defaulted to ready.
    const snapshot: Mt5PermissionSnapshot | null = null;
    const readiness = evaluateReadiness({
      snapshot,
      expectedLoginId: process.env.XAUUSD_M1M5_EXPECTED_LOGIN?.trim() ?? null,
      nowMs: now,
    });

    const limitations = [...(state?.observationLimitations ?? [])];
    if (!heartbeatFresh) {
      limitations.push(
        state === null
          ? 'No observation-loop state file found. The watch process has not run, or its state was written under ' +
            'different rules and was refused. Nothing is observing RSI.'
          : `The observation loop's last cycle was ${Math.round((now - state.lastCycleAtMs) / 1000)}s ago, beyond ` +
            `the ${HEARTBEAT_STALE_AFTER_MS / 1000}s heartbeat budget. The values below are its last snapshot, ` +
            'not current readings.',
      );
    }

    const eligibility = evaluateEntryEligibility(now, {
      // Session state comes from the collector, which is not wired yet.
      // null blocks, which is the correct and honest default (§9.4).
      brokerSessionOpen: null,
      dataFresh: heartbeatFresh,
      recoveryComplete: state?.recoveryCompleteAtMs !== null && state?.recoveryCompleteAtMs !== undefined,
      killSwitchEngaged: killSwitchState().active,
      executionBlockers: readiness.blockers.map((b) => b.code),
    });

    const view = buildDashboardView({
      buildCommit: process.env.BUILD_COMMIT?.trim() ?? null,
      accountLabel: account?.displayName ?? null,
      executionMode: getM1M5ExecutionMode(),
      engines: {
        M1: state?.engines.M1 ?? createEngineState('M1'),
        M5: state?.engines.M5 ?? createEngineState('M5'),
      },
      crossings: {
        M1: state?.crossings.M1 ?? createCrossingState('M1', SPEC_HASH),
        M5: state?.crossings.M5 ?? createCrossingState('M5', SPEC_HASH),
      },
      occupancy,
      locks,
      eligibility,
      readiness,
      liquidation: { underway: false, confirmedFlat: false, deadlineMissed: false },
      observationLimitations: limitations,
    });

    // --- Foreign exposure, reported separately and never folded in (§9.3).
    //
    // Filtered in code rather than in the query: MT5's magic number lives
    // inside the position's raw payload, not in a column, so there is nothing
    // to put in a WHERE clause. A position whose magic cannot be read is
    // treated as foreign, which is the safe direction.
    const openPositions = accountId
      ? await this.prisma.position.findMany({ where: { accountId, symbol: 'XAUUSD', status: 'OPEN' } })
      : [];
    const foreignPositions = openPositions.filter(
      (p) => !V2_MAGIC_NUMBERS.includes(extractMagic(p.rawPayload) ?? Number.NaN),
    );

    return {
      ...view,
      heartbeat: {
        fresh: heartbeatFresh,
        lastCycleAt: state ? new Date(state.lastCycleAtMs).toISOString() : null,
        lastCycleIntervalMs: state?.lastCycleIntervalMs ?? null,
        // Reported separately from the observation cadence, because a
        // one-second observation loop does not imply a one-second
        // order-polling loop (§10).
        lastSubmissionLatencyMs: state?.lastSubmissionLatencyMs ?? null,
      },
      controls: {
        executionMode: getM1M5ExecutionMode(),
        killSwitch: killSwitchState(),
        stopNewEntries: stopNewEntriesState(),
        entriesBlockedReason: submissionBlockedReason(),
      },
      nextEligibility: describeNextEligibility(view.schedule.nextEligibleT),
      foreignExposure: {
        count: foreignPositions.length,
        note:
          'Positions on this account that this application does not own. They are displayed and counted for ' +
          'exposure, and are never closed, modified, adopted or relabelled.',
        positions: foreignPositions.map((p) => ({
          ticket: p.externalPositionId,
          ownership: describeOwnership(extractMagic(p.rawPayload)),
        })),
      },
      meta: {
        strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
        specHash: SPEC_HASH,
        timeframes: TIMEFRAMES,
        generatedAt: new Date(now).toISOString(),
      },
    };
  }
}
