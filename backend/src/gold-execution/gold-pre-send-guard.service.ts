import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isGoldKillSwitchActive } from './gold-kill-switch';
import { GoldAccountStateService } from './gold-account-state.service';
import { isStopNewEntriesActive } from './gold-execution-mode';
import { GOLD_MAX_ENTRY_DEVIATION_POINTS, GOLD_MAX_SIGNAL_AGE_SECONDS, GOLD_POINT_SIZE, GOLD_SYMBOL } from './gold-safety-constants';
import { SPEC } from '../research/confirmed-retest-v2/spec';
import { beirutSecondsOfDay } from '../research/confirmed-retest-v2/time';

export interface GoldPreSendCheckResult {
  ok: boolean;
  reason: string | null;
}

/**
 * Re-verifies everything `GoldExecutionCoordinatorService.evaluate()` already
 * checked, ONE MORE TIME, at the actual hand-off to the collector — the
 * point closest this backend can get to the real broker-send boundary
 * without reaching into the Python executor. The task's own framing: "A
 * coordinator check before a DB write does not cover subsequent queue
 * delay." Concretely, everything between `evaluate()`'s DB write (PENDING)
 * and the collector's next poll (up to `POLL_INTERVAL_SECONDS`, plus
 * whatever backend/network hiccup) is currently unchecked — a decision
 * queued one second before the Beirut window closes, or before a kill
 * switch engages, or before price moves past the deviation tolerance,
 * would otherwise sail through untouched.
 *
 * Called by `GoldExecutionController.getPendingOrder` AFTER the atomic
 * PENDING -> SENT claim (so the collector cannot poll it again in the
 * meantime), but BEFORE it is handed to the collector to actually send.
 * On failure, the caller must cancel the claimed decision (mark it FAILED
 * with this reason) and return `{ order: null }` — never hand a
 * now-invalid order to the collector just because it was already claimed.
 *
 * Deliberately uses the freshest `LiveTick.tickAt` as its reference "now"
 * for the window/freshness checks below, rather than the backend process's
 * own wall clock: this ties the recheck to the most recent instant we
 * actually have real market information for (which in healthy operation is
 * within a few seconds of true wall time — the collector pushes a fresh
 * tick roughly every `POLL_INTERVAL_SECONDS`), and it means a stale/absent
 * tick fails the check for an honest reason (see below) rather than the
 * check silently passing against a live process clock while the market
 * data behind it is actually stale.
 */
@Injectable()
export class GoldPreSendGuardService {
  private readonly logger = new Logger(GoldPreSendGuardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: GoldAccountStateService,
  ) {}

  async check(params: {
    decisionId: string;
    accountId: string;
    action: 'OPEN_BUY' | 'OPEN_SELL';
    entryPrice: number;
    /** From the original decision's own recorded input — when the touch that produced this decision was first knowable. Required: without it, freshness cannot be honestly re-verified, so a missing/invalid value fails closed. */
    touchEndT: number | null;
  }): Promise<GoldPreSendCheckResult> {
    const { decisionId, accountId, action, entryPrice, touchEndT } = params;

    if (isGoldKillSwitchActive()) {
      return { ok: false, reason: 'Kill switch is active — refusing to send at the final pre-send check.' };
    }
    if (isStopNewEntriesActive()) {
      return { ok: false, reason: 'STOP NEW ENTRIES is active — refusing to send at the final pre-send check.' };
    }

    const tick = await this.prisma.liveTick.findUnique({ where: { symbol: GOLD_SYMBOL } });
    if (!tick) {
      return { ok: false, reason: 'No live XAUUSD quote available at send time — refusing to send blind (cannot verify window, freshness, or price deviation without one).' };
    }
    const nowT = tick.tickAt.getTime();

    const nowBeirutSecs = beirutSecondsOfDay(nowT);
    const stillInWindow = nowBeirutSecs >= SPEC.session.entryWindowStartSecondsBeirut && nowBeirutSecs < SPEC.session.entryWindowEndSecondsBeirutExclusive;
    if (!stillInWindow) {
      return { ok: false, reason: `Current time (${new Date(nowT).toISOString()}, from the latest live quote) has moved outside the 04:00-12:00 Asia/Beirut entry window since this decision was queued — refusing to send a late order.` };
    }

    if (touchEndT === null || !Number.isFinite(touchEndT)) {
      return { ok: false, reason: 'Cannot verify signal freshness at send time — original touch timestamp is missing from the decision record. Refusing to send rather than assume freshness.' };
    }
    const signalAgeSeconds = (nowT - touchEndT) / 1000;
    if (signalAgeSeconds > GOLD_MAX_SIGNAL_AGE_SECONDS) {
      return { ok: false, reason: `Signal is ${signalAgeSeconds.toFixed(0)}s old at send time (max ${GOLD_MAX_SIGNAL_AGE_SECONDS}s) — refusing to send a stale touch.` };
    }

    const currentExecutablePrice = action === 'OPEN_BUY' ? tick.ask.toNumber() : tick.bid.toNumber();
    const entryDeviationPoints = Math.abs(currentExecutablePrice - entryPrice) / GOLD_POINT_SIZE;
    if (entryDeviationPoints > GOLD_MAX_ENTRY_DEVIATION_POINTS) {
      return { ok: false, reason: `Executable price has moved ${entryDeviationPoints.toFixed(1)}pt since this decision was queued (max ${GOLD_MAX_ENTRY_DEVIATION_POINTS}pt) — refusing to send, not chasing.` };
    }

    const occupancy = await this.accountState.resolveOccupancy(accountId, decisionId);
    if (occupancy.hasExistingXauusdExposure) {
      return { ok: false, reason: `Existing XAUUSD exposure appeared since this decision was queued (${occupancy.exposureDescription ?? 'unspecified'}) — refusing to send a second position.` };
    }

    const riskInfo = await this.accountState.resolveAccountRiskInfo(accountId);
    if (riskInfo.tradeMode !== 'DEMO') {
      return { ok: false, reason: `Account trade_mode is now "${riskInfo.tradeMode}", not DEMO — refusing to send at the final pre-send check. This is an absolute, non-negotiable safety rule.` };
    }

    return { ok: true, reason: null };
  }
}
