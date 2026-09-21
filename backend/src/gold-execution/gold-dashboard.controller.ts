import { Controller, Get, UseGuards } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { GoldAccountStateService } from './gold-account-state.service';
import { getGoldExecutionMode, isStopNewEntriesActive } from './gold-execution-mode';
import { isGoldKillSwitchActive } from './gold-kill-switch';
import {
  GOLD_COMBINED_RISK_CAP_PCT, GOLD_DAILY_LOSS_CAP_PCT, GOLD_DRAWDOWN_CAP_PCT, GOLD_MAGIC_NUMBER,
  GOLD_MAX_ENTRY_DEVIATION_POINTS, GOLD_POINT_SIZE, GOLD_STOP_RISK_CAP_PCT, GOLD_SYMBOL,
  GOLD_TP_SL_USD,
} from './gold-safety-constants';
import { XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_VERSION } from './gold-strategy-version';
import { beirutSecondsOfDay } from '../research/confirmed-retest-v2/time';
import { SPEC } from '../research/confirmed-retest-v2/spec';
import { GoldRuntimeSettingsService } from './gold-runtime-settings.service';

// Same default as health-check.processor.ts's DEFAULT_STALE_THRESHOLD_SECONDS
// (HEARTBEAT_STALE_THRESHOLD_SECONDS) — reused rather than inventing a
// second staleness threshold for the same concept.
const HEARTBEAT_STALE_THRESHOLD_SECONDS = Number(process.env.HEARTBEAT_STALE_THRESHOLD_SECONDS ?? '300');

/**
 * Reads `scripts/gold-execution-scheduler.ts`'s own state file directly
 * (same path convention: `GOLD_RESEARCH_STATE_DIR` env var, else
 * `<backend>/research-state/gold-live-watch/gold-watch-state.json`) —
 * that standalone process is NOT part of this Nest app (it's launched
 * separately, see start-gold-demo.ps1), so this is a live read of its
 * on-disk state, not a DI-wired service call. Deliberately requires the
 * cycle timestamp to be RECENT (within HEARTBEAT_STALE_THRESHOLD_SECONDS)
 * before calling it "live" — a past `lastCycleAtUtc` from a scheduler
 * process that has since died must never be presented as current health.
 */
function readGoldSchedulerHeartbeat(): { lastCycleAtUtc: string | null; ageMs: number | null; stale: boolean; activeLevelIds: string[] } {
  const stateDir = process.env.GOLD_RESEARCH_STATE_DIR ?? resolve(__dirname, '..', '..', 'research-state', 'gold-live-watch');
  const statePath = resolve(stateDir, 'gold-watch-state.json');
  if (!existsSync(statePath)) {
    return { lastCycleAtUtc: null, ageMs: null, stale: true, activeLevelIds: [] };
  }
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      lastCycleAtUtc?: string | null;
      replay?: { levels?: { activeLevelIds?: string[] } } | null;
    };
    const lastCycleAtUtc = state.lastCycleAtUtc ?? null;
    const ageMs = lastCycleAtUtc ? Date.now() - new Date(lastCycleAtUtc).getTime() : null;
    return {
      lastCycleAtUtc,
      ageMs,
      stale: ageMs === null || ageMs > HEARTBEAT_STALE_THRESHOLD_SECONDS * 1000,
      activeLevelIds: state.replay?.levels?.activeLevelIds ?? [],
    };
  } catch {
    // Unreadable/corrupt state file — fail closed to "stale", never assume liveness we can't verify.
    return { lastCycleAtUtc: null, ageMs: null, stale: true, activeLevelIds: [] };
  }
}

/**
 * Dashboard read side for the gold execution strategy (task step 6F) —
 * fully separate from `ConfirmedRetestController` (v1/v2 research-only,
 * file-based, no account). This one is account-scoped and reads real DB
 * state: `AutonomousDecision` rows (symbol='XAUUSD') for recent
 * queued/skipped decisions and reasoning, `Position`/`Trade` for open/
 * closed gold exposure with real P&L, `AccountSnapshot`/`SymbolMetadata`
 * for freshness and broker constraints. LLM explanations are never
 * involved here — every field is a direct read, per the task's own "LLM
 * explanations must never change levels/orders/volume/risk/outcomes" rule
 * (trivially true: this controller has no LLM dependency at all).
 */
@Controller('research/gold-execution-status')
@UseGuards(DashboardTokenGuard)
export class GoldDashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: GoldAccountStateService,
    private readonly runtimeSettings: GoldRuntimeSettingsService,
  ) {}

  @Get()
  async getStatus() {
    const mode = getGoldExecutionMode();
    const stopNewEntriesActive = isStopNewEntriesActive();
    const killSwitchActive = isGoldKillSwitchActive();

    // Gold trades on MT5 only — this deployment holds more than one
    // TradingAccount row (an XTB account exists alongside the MT5 one), so
    // "first created" is NOT a safe way to pick "the" account (found live,
    // the hard way, while verifying trade_mode: an earlier version of this
    // query picked the XTB account, which has no snapshots at all, instead
    // of the actual MT5 MetaQuotes-Demo account). Explicit platform filter
    // instead.
    const account = await this.prisma.tradingAccount.findFirst({ where: { platform: 'MT5' }, orderBy: { createdAt: 'asc' } });

    const eurusdBanner = {
      strategy: 'EURUSD (friend\'s legacy 2024 rules)',
      status: 'INACTIVE',
      note: 'EURUSD strategy is a separate legacy strategy and is NOT activated by gold execution. EURUSD collection, configurable volume, and account-wide occupancy protection remain independently in effect.',
    };

    if (!account) {
      return {
        strategyVersion: XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_VERSION,
        mode, stopNewEntriesActive, killSwitchActive,
        error: 'no trading account found',
        eurusd: eurusdBanner,
      };
    }

    const [snapshot, symbolMeta, openPositions, closedTrades, recentDecisions, heartbeat, liveTick, recentGoldNotifications] = await Promise.all([
      this.prisma.accountSnapshot.findFirst({ where: { accountId: account.id }, orderBy: { capturedAt: 'desc' } }),
      this.prisma.symbolMetadata.findUnique({ where: { symbol: GOLD_SYMBOL } }),
      this.prisma.position.findMany({ where: { accountId: account.id, symbol: GOLD_SYMBOL, status: 'OPEN' } }),
      this.prisma.trade.findMany({ where: { accountId: account.id, symbol: GOLD_SYMBOL }, orderBy: { executedAt: 'desc' }, take: 20 }),
      this.prisma.autonomousDecision.findMany({ where: { accountId: account.id, symbol: GOLD_SYMBOL }, orderBy: { evaluatedAt: 'desc' }, take: 20 }),
      this.prisma.collectorHeartbeat.findUnique({ where: { accountId: account.id } }),
      this.prisma.liveTick.findUnique({ where: { symbol: GOLD_SYMBOL } }),
      // Defensive against a stale/partially-regenerated Prisma client (see
      // gold-execution's operational notes on the query-engine file lock) —
      // this table is brand new, so a not-yet-regenerated client simply
      // won't have this accessor at all; degrade to an empty list rather
      // than 500 the whole dashboard.
      Promise.resolve()
        .then(() => this.prisma.goldTelegramNotification?.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }))
        .catch(() => undefined)
        .then((rows) => rows ?? []),
    ]);

    const occupancy = await this.accountState.resolveOccupancy(account.id);
    const volumeConstraints = await this.accountState.resolveVolumeConstraints();

    const now = Date.now();
    const snapshotAgeMs = snapshot ? now - snapshot.capturedAt.getTime() : null;
    const symbolMetaAgeMs = symbolMeta ? now - symbolMeta.updatedAt.getTime() : null;
    const heartbeatAgeMs = heartbeat ? now - heartbeat.lastHeartbeatAt.getTime() : null;
    const liveTickAgeMs = liveTick ? now - liveTick.tickAt.getTime() : null;

    const nowBeirutSecs = beirutSecondsOfDay(now);
    const entryWindowOpen =
      nowBeirutSecs >= SPEC.session.entryWindowStartSecondsBeirut && nowBeirutSecs < SPEC.session.entryWindowEndSecondsBeirutExclusive;

    // Protection status computed live off the SAME position rows the rest
    // of this response already reads — no extra query, same isSet
    // convention as gold-protection-monitor.service.ts (0 counts as unset,
    // matching MT5's own "no stop" representation).
    const isProtectionSet = (v: number | null) => v !== null && v !== 0;
    const openPositionsWithProtection = openPositions.map((p) => ({
      externalPositionId: p.externalPositionId,
      isProtected: isProtectionSet(p.stopLoss?.toNumber() ?? null) && isProtectionSet(p.takeProfit?.toNumber() ?? null),
    }));

    return {
      strategyVersion: XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_VERSION,
      accountMode: mode,
      stopNewEntriesActive,
      killSwitchActive,
      accountTradeMode: snapshot?.tradeMode ?? null, // null = fails closed elsewhere to REAL, never assumed DEMO here either
      settings: {
        symbol: GOLD_SYMBOL,
        // The CURRENT live volume setting — read fresh on every evaluation
        // by the coordinator, threaded through risk calculation (the SAME
        // number), and persisted onto each decision so the eventual broker
        // submission uses exactly what risk was computed against. Initial
        // default 0.01 (GOLD_VOLUME_LOTS) until changed via the dashboard.
        volumeLots: this.runtimeSettings.getVolumeLots(),
        volumeOverride: {
          value: this.runtimeSettings.getVolumeLots(),
          active: true,
          note: 'Live — validated against broker step/min/max on save, audited, and used by the risk gate + broker submission for every NEW decision from the next evaluation onward. Never resizes an already-open position or a decision already queued.',
        },
        magicNumber: GOLD_MAGIC_NUMBER,
        tpSlUsd: GOLD_TP_SL_USD,
        pointSize: GOLD_POINT_SIZE,
        maxEntryDeviationPoints: GOLD_MAX_ENTRY_DEVIATION_POINTS,
        riskCapsPct: {
          stopRisk: GOLD_STOP_RISK_CAP_PCT, combined: GOLD_COMBINED_RISK_CAP_PCT,
          dailyLoss: GOLD_DAILY_LOSS_CAP_PCT, drawdown: GOLD_DRAWDOWN_CAP_PCT,
        },
        note: 'Only the user changes volumeLots — this dashboard never resizes it.',
      },
      occupancy,
      volumeConstraints,
      openPositions: openPositions.map((p) => ({
        ticket: p.externalPositionId, side: p.side, volume: p.volume.toNumber(),
        entryPrice: p.openPrice.toNumber(), currentPrice: p.currentPrice?.toNumber() ?? null,
        stopLoss: p.stopLoss?.toNumber() ?? null, takeProfit: p.takeProfit?.toNumber() ?? null,
        floatingPnl: p.profit.toNumber(), openedAt: p.openedAt,
        isProtected: openPositionsWithProtection.find((x) => x.externalPositionId === p.externalPositionId)?.isProtected ?? false,
      })),
      recentNotifications: (recentGoldNotifications as { eventType: string; status: string; createdAt: Date; text: string }[]).map((n) => ({
        eventType: n.eventType, status: n.status, createdAt: n.createdAt, text: n.text,
      })),
      collectorHeartbeat: {
        lastHeartbeatAt: heartbeat?.lastHeartbeatAt ?? null,
        ageMs: heartbeatAgeMs,
        stale: heartbeatAgeMs === null || heartbeatAgeMs > 5 * 60_000,
        mt5Connected: heartbeat?.mt5Connected ?? null,
        lastError: heartbeat?.lastError ?? null,
      },
      liveQuote: {
        bid: liveTick?.bid?.toNumber() ?? null, ask: liveTick?.ask?.toNumber() ?? null,
        ageMs: liveTickAgeMs, stale: liveTickAgeMs === null || liveTickAgeMs > 60_000,
      },
      entryWindow: {
        timezone: 'Asia/Beirut',
        startSecondsBeirut: SPEC.session.entryWindowStartSecondsBeirut,
        endSecondsBeirutExclusive: SPEC.session.entryWindowEndSecondsBeirutExclusive,
        open: entryWindowOpen,
      },
      closedTrades: closedTrades.map((t) => ({
        dealTicket: t.externalTradeId, side: t.side, volume: t.volume.toNumber(),
        price: t.price.toNumber(), realizedPnl: t.profit.toNumber(), executedAt: t.executedAt,
      })),
      recentDecisions: recentDecisions.map((d) => {
        const touchEndT = extractTouchEndT(d.inputSnapshot);
        return {
          id: d.id, evaluatedAt: d.evaluatedAt, action: d.action, orderStatus: d.orderStatus,
          riskManagerApproved: d.riskManagerApproved, riskManagerRejectionReason: d.riskManagerRejectionReason,
          reasoning: d.reasoning, entryPrice: d.entryPrice?.toNumber() ?? null,
          stopLoss: d.stopLoss?.toNumber() ?? null, takeProfit: d.takeProfit?.toNumber() ?? null,
          mt5Ticket: d.mt5Ticket ?? null, filledPrice: d.filledPrice?.toNumber() ?? null, executionError: d.executionError ?? null,
          // The M1 touch's own close time (when the historical/live touch
          // actually happened) — distinct from `evaluatedAt` (when this row
          // was logged/replayed). Null when the decision row predates
          // `signal.touchEndT` being recorded, or was never a touch-driven
          // decision at all.
          touchEndTIso: touchEndT !== null ? new Date(touchEndT).toISOString() : null,
        };
      }),
      goldScheduler: readGoldSchedulerHeartbeat(),
      dataFreshness: {
        accountSnapshotAgeMs: snapshotAgeMs,
        accountSnapshotStale: snapshotAgeMs === null || snapshotAgeMs > 5 * 60_000,
        symbolMetadataAgeMs: symbolMetaAgeMs,
        symbolMetadataStale: symbolMetaAgeMs === null || symbolMetaAgeMs > 24 * 60 * 60_000,
      },
      eurusd: eurusdBanner,
    };
  }
}

/**
 * Same extraction as `gold-execution.controller.ts`'s own (private) helper
 * of the same name — kept as a duplicate rather than exported/shared to
 * avoid coupling the collector-facing controller's module boundary to this
 * read-only dashboard one; both read the identical `inputSnapshot` shape
 * (`{ signal: { touchEndT }, ... }`) that `GoldExecutionCoordinatorService.evaluate()` writes.
 */
function extractTouchEndT(inputSnapshot: unknown): number | null {
  if (typeof inputSnapshot !== 'object' || inputSnapshot === null) return null;
  const signal = (inputSnapshot as Record<string, unknown>).signal;
  if (typeof signal !== 'object' || signal === null) return null;
  const touchEndT = (signal as Record<string, unknown>).touchEndT;
  return typeof touchEndT === 'number' && Number.isFinite(touchEndT) ? touchEndT : null;
}
