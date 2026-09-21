import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isTrendBreakoutKillSwitchActive } from './trend-breakout-kill-switch';
import { isStopNewEntriesActive } from './trend-breakout-execution-mode';
import { isSignalExpired } from './entry-timing';
import { isWithinEntryWindow } from './schedule';
import { getMaxEntryDeviationPoints, TREND_BREAKOUT_FALLBACK_POINT_SIZE } from './execution-constants';
import { TrendBreakoutInstrumentId } from './instrument-config';
import { TrendBreakoutSlotLockService } from './slot-lock.service';
import { SymbolMetadataService } from './symbol-metadata.service';

export interface TrendBreakoutPreSendCheckResult {
  ok: boolean;
  reason: string | null;
}

/**
 * Re-verifies everything `TrendBreakoutCoordinatorService.evaluateInstrument()`
 * already checked, ONE MORE TIME, at the actual hand-off to the collector —
 * same posture and purpose as `../gold-execution/gold-pre-send-guard.service.ts`.
 * Called by `TrendBreakoutExecutionController.getPendingOrder` AFTER the
 * atomic PENDING -> SENT claim (so the collector cannot poll this row again
 * in the meantime), but BEFORE it is handed to the collector to actually
 * send. On failure, the caller must cancel the claimed decision (mark it
 * FAILED with this reason) and release the instrument's slot lock — never
 * hand a now-invalid order to the collector just because it was already
 * claimed, and never leave the slot stuck occupied by a decision that will
 * never actually open a position.
 *
 * Deliberately uses the freshest `LiveTick.tickAt` as its reference "now"
 * for the window/freshness checks below, rather than the backend process's
 * own wall clock — same reasoning as gold's own guard: this ties the
 * recheck to the most recent instant real market data is actually known
 * for, and a stale/absent tick fails the check for an honest reason rather
 * than silently passing against a live process clock while market data
 * behind it is stale.
 */
@Injectable()
export class TrendBreakoutPreSendGuardService {
  private readonly logger = new Logger(TrendBreakoutPreSendGuardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slotLock: TrendBreakoutSlotLockService,
    private readonly symbolMetadata: SymbolMetadataService,
  ) {}

  async check(params: {
    decisionId: string;
    accountId: string;
    instrument: TrendBreakoutInstrumentId;
    brokerSymbol: string;
    action: 'OPEN_BUY' | 'OPEN_SELL';
    entryPrice: number;
    /** The original decision's own `signalCloseAt` — reused as the freshness reference per `entry-timing.ts::isSignalExpired`, rather than a second, separate age threshold. */
    signalCloseAt: Date;
  }): Promise<TrendBreakoutPreSendCheckResult> {
    const { decisionId, accountId, instrument, brokerSymbol, action, entryPrice, signalCloseAt } = params;

    if (isTrendBreakoutKillSwitchActive()) {
      return { ok: false, reason: 'Trend-breakout kill switch is active — refusing to send at the final pre-send check.' };
    }
    if (isStopNewEntriesActive()) {
      return { ok: false, reason: 'Trend-breakout STOP NEW ENTRIES is active — refusing to send at the final pre-send check.' };
    }

    const tick = await this.prisma.liveTick.findUnique({ where: { symbol: brokerSymbol } });
    if (!tick) {
      return { ok: false, reason: `No live ${brokerSymbol} quote available at send time — refusing to send blind (cannot verify window, freshness, or price deviation without one).` };
    }
    const now = tick.tickAt;

    if (!isWithinEntryWindow(now)) {
      return { ok: false, reason: `Current time (${now.toISOString()}, from the latest live quote) has moved outside the Beirut 03:00-12:00 entry window since this decision was queued — refusing to send a late order.` };
    }

    if (isSignalExpired(signalCloseAt, now)) {
      return { ok: false, reason: `Setup expired: signal closed at ${signalCloseAt.toISOString()}, latest quote is at ${now.toISOString()} (>= 60s) — refusing to send a stale setup.` };
    }

    const metadata = await this.symbolMetadata.get(brokerSymbol);
    const pointSize = metadata?.point ?? TREND_BREAKOUT_FALLBACK_POINT_SIZE[instrument];
    const currentExecutablePrice = action === 'OPEN_BUY' ? tick.ask.toNumber() : tick.bid.toNumber();
    const maxDeviationPoints = getMaxEntryDeviationPoints(instrument);
    const entryDeviationPoints = Math.abs(currentExecutablePrice - entryPrice) / pointSize;
    if (entryDeviationPoints > maxDeviationPoints) {
      return { ok: false, reason: `Executable price has moved ${entryDeviationPoints.toFixed(1)}pt since this decision was queued (max ${maxDeviationPoints}pt) — refusing to send, not chasing.` };
    }

    // Existing-exposure re-check. The slot lock for this instrument was
    // already claimed atomically at decision-creation time (the coordinator's
    // own transaction), and the PK on (accountId, instrument) makes a SECOND
    // lock for the same instrument impossible — so the only way this can be
    // "occupied by someone else" is if the lock that exists does not belong
    // to THIS decision, which would mean this decision's own claim was
    // somehow lost or superseded. Fail closed rather than assume it's fine.
    const lock = await this.slotLock.getLock(accountId, instrument);
    if (!lock || lock.decisionId !== decisionId) {
      return { ok: false, reason: `${instrument}'s slot lock does not match this decision at send time (lock=${lock?.decisionId ?? 'none'}, decision=${decisionId}) — refusing to send.` };
    }

    const latestSnapshot = await this.prisma.accountSnapshot.findFirst({ where: { accountId }, orderBy: { capturedAt: 'desc' } });
    // Fails closed: no snapshot, or one that never recorded tradeMode, is
    // treated as REAL, never silently as DEMO — same posture as gold's own
    // GoldAccountStateService.resolveAccountRiskInfo.
    const tradeMode = latestSnapshot?.tradeMode ?? 'REAL';
    if (tradeMode !== 'DEMO') {
      return { ok: false, reason: `Account trade_mode is now "${tradeMode}", not DEMO — refusing to send at the final pre-send check. This is an absolute, non-negotiable safety rule.` };
    }

    return { ok: true, reason: null };
  }
}
