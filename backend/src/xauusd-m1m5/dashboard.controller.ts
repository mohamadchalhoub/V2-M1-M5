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
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { M1M5Mt5SnapshotService } from './mt5-snapshot.service';
import { executionLatency } from './execution-latency';
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
import { V2_MAGIC_NUMBERS, V2_SYMBOL } from './safety-constants';
import { setVolume } from './volume-setting';
import { validateVolume } from './volume';

class SetM1M5VolumeDto {
  @IsNumber() volumeLots!: number;
  @IsOptional() @IsString() note?: string;
}

@Controller('xauusd-m1m5')
@UseGuards(DashboardTokenGuard)
export class M1M5DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: M1M5Mt5SnapshotService,
  ) {}

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

    // --- MT5 readiness and broker session: the SAME sources the observation
    // loop decides with -- the collector's permission snapshot and its
    // session report -- so the dashboard cannot say "not ready" while the
    // loop trades, or the reverse. These were placeholders (null) from before
    // the permission pipeline existed, and the page showed NO_SNAPSHOT and
    // "session unknown" while the bot was placing real orders.
    const latestMt5 = accountId ? await this.snapshots.latest(accountId) : null;
    const snapshot: Mt5PermissionSnapshot | null = latestMt5?.permissions ?? null;
    const readiness = evaluateReadiness({
      snapshot,
      // MT5_EXPECTED_LOGIN is the variable the loop reads. The old name is
      // kept only as a fallback so an existing env file still works.
      expectedLoginId:
        process.env.MT5_EXPECTED_LOGIN?.trim() || process.env.XAUUSD_M1M5_EXPECTED_LOGIN?.trim() || null,
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
      // From the collector, as the loop reads it. Still null -- which blocks
      // -- when the collector has not reported one (§9.4).
      brokerSessionOpen: latestMt5?.sessionOpen ?? null,
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

    // The most recent order that reached the broker, with its measured
    // execution timeline -- so our scheduling delay and the broker's latency
    // are visible separately rather than folded into one "it was slow".
    const lastSubmitted = accountId
      ? await this.prisma.xauusdM1M5Decision.findFirst({
          where: { accountId, submittedAt: { not: null } },
          orderBy: { submittedAt: 'desc' },
        })
      : null;
    const lastExecution = lastSubmitted
      ? {
          decisionId: lastSubmitted.id,
          timeframe: lastSubmitted.timeframe,
          direction: lastSubmitted.direction,
          orderStatus: lastSubmitted.orderStatus,
          ticket: lastSubmitted.ticket === null ? null : lastSubmitted.ticket.toString(),
          signalDetectedAt: lastSubmitted.detectedAt?.toISOString() ?? null,
          executionEvaluatedAt: lastSubmitted.executionEvaluatedAt?.toISOString() ?? null,
          brokerSubmittedAt: lastSubmitted.submittedAt?.toISOString() ?? null,
          brokerAcknowledgedAt: lastSubmitted.acknowledgedAt?.toISOString() ?? null,
          ...executionLatency(lastSubmitted),
        }
      : null;

    return {
      ...view,
      lastExecution,
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

  /** Broker-validated (live SymbolMetadata min/max/step) volume for this strategy's own orders. */
  @Get('volume')
  async getVolume() {
    const account = await this.prisma.tradingAccount.findFirst({ orderBy: { createdAt: 'asc' } });
    const accountId = account?.id ?? null;
    const metadata = accountId ? await this.prisma.symbolMetadata.findUnique({ where: { symbol: V2_SYMBOL } }) : null;
    const setting = accountId ? await this.prisma.xauusdM1M5VolumeSetting.findUnique({ where: { accountId } }) : null;
    const auditRows = accountId
      ? await this.prisma.xauusdM1M5VolumeAudit.findMany({ where: { accountId }, orderBy: { changedAt: 'desc' }, take: 10 })
      : [];
    return {
      volumeLots: setting ? Number(setting.volumeLots) : null,
      provenance: setting?.provenance ?? null,
      constraints: metadata
        ? { minLots: Number(metadata.volumeMin), maxLots: Number(metadata.volumeMax), stepLots: Number(metadata.volumeStep) }
        : null,
      audit: auditRows.map((a) => ({
        previousLots: a.previousLots ? Number(a.previousLots) : null,
        newLots: Number(a.newLots),
        changedBy: a.changedBy,
        changedAt: a.changedAt.toISOString(),
        provenance: a.provenance,
      })),
    };
  }

  /**
   * Sets this strategy's own order volume. Never resizes an already-open
   * position or a decision already queued -- live from the next evaluation
   * onward, same as the gold-demo control this mirrors.
   */
  @Post('volume')
  async setVolume(@Body() dto: SetM1M5VolumeDto) {
    const account = await this.prisma.tradingAccount.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!account) return { ok: false, error: 'no trading account exists yet' };

    const metadata = await this.prisma.symbolMetadata.findUnique({ where: { symbol: V2_SYMBOL } });
    if (metadata) {
      const limits = { min: Number(metadata.volumeMin), max: Number(metadata.volumeMax), step: Number(metadata.volumeStep) };
      const check = validateVolume(dto.volumeLots, limits);
      if (!check.acceptable) {
        return {
          ok: false,
          error: `${dto.volumeLots} lot is not valid for this broker (min ${limits.min}, max ${limits.max}, step ${limits.step}): ${check.reason}`,
        };
      }
    }

    const result = await setVolume(this.prisma as any, {
      accountId: account.id,
      lots: dto.volumeLots,
      changedBy: 'dashboard operator',
      note: dto.note ?? 'dashboard change',
    });
    if (!result.ok) return { ok: false, error: result.reason };
    return {
      ok: true,
      volumeLots: result.lots,
      previousLots: result.previousLots,
      stopRiskPct: result.stopRiskPct,
      aboveCap: result.aboveCap,
    };
  }

}
