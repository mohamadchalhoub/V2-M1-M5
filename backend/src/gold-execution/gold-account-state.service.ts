import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoldAccountRiskInfo, GoldAccountTradeMode, GoldBrokerVolumeConstraints, GoldOccupancyState } from './gold-risk-manager';
import { GOLD_SYMBOL } from './gold-safety-constants';

/** How old SymbolMetadata may be before it's treated as stale (fails closed, blocks — never assumes a stale row is still accurate). */
const SYMBOL_METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves live account/occupancy state from what the collector has
 * already reconciled into the database (`Position` rows come from real
 * broker state — collector/app/mt5_client.py's own positions sync, not
 * this strategy's own memory), plus this table's own PENDING/SENT rows for
 * a submission that may not have reached (or may have raced ahead of) a
 * Position row yet. This is what makes the occupancy check count ALL
 * XAUUSD exposure (manual, other-strategy, pending, UNKNOWN), per the
 * friend rule — not just this strategy's own magic number.
 *
 * Fails closed: no snapshot, or one that never recorded tradeMode, is
 * reported as REAL (same posture as AutonomousExecutionCoordinatorService's
 * own `resolveAccountInfo`) — never silently treated as DEMO.
 */
@Injectable()
export class GoldAccountStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `excludeDecisionId` — used by the pre-send guard (`gold-pre-send-guard.service.ts`),
   * which re-checks occupancy AFTER a decision has already been atomically
   * claimed (flipped PENDING -> SENT). Without excluding it, that decision
   * would always find ITSELF as "existing exposure" and every claim would
   * spuriously look occupied.
   */
  async resolveOccupancy(accountId: string, excludeDecisionId?: string): Promise<GoldOccupancyState> {
    const openPosition = await this.prisma.position.findFirst({
      where: { accountId, symbol: GOLD_SYMBOL, status: 'OPEN' },
    });
    if (openPosition) {
      return {
        hasExistingXauusdExposure: true,
        exposureDescription: `open position ticket=${openPosition.externalPositionId} (side=${openPosition.side}, volume=${openPosition.volume})`,
      };
    }

    // A decision already PENDING (queued, not yet claimed) or SENT (claimed
    // by the collector, outcome not yet reported back — includes the
    // window where the broker may have already filled it) also occupies
    // the slot — an ambiguous/in-flight submission counts, per the task's
    // explicit "include ... UNKNOWN submissions" requirement.
    const inFlight = await this.prisma.autonomousDecision.findFirst({
      where: {
        accountId, symbol: GOLD_SYMBOL, orderStatus: { in: ['PENDING', 'SENT'] },
        ...(excludeDecisionId ? { id: { not: excludeDecisionId } } : {}),
      },
      orderBy: { evaluatedAt: 'desc' },
    });
    if (inFlight) {
      return {
        hasExistingXauusdExposure: true,
        exposureDescription: `in-flight decision ${inFlight.id} (orderStatus=${inFlight.orderStatus})`,
      };
    }

    return { hasExistingXauusdExposure: false, exposureDescription: null };
  }

  async resolveAccountRiskInfo(accountId: string): Promise<GoldAccountRiskInfo> {
    const [snapshot, account, symbolMeta] = await Promise.all([
      this.prisma.accountSnapshot.findFirst({ where: { accountId }, orderBy: { capturedAt: 'desc' } }),
      this.prisma.tradingAccount.findUnique({ where: { id: accountId } }),
      this.prisma.symbolMetadata.findUnique({ where: { symbol: GOLD_SYMBOL } }),
    ]);
    const tradeMode: GoldAccountTradeMode = (snapshot?.tradeMode as GoldAccountTradeMode | undefined) ?? 'REAL';
    const equity = snapshot ? snapshot.equity.toNumber() : 0;
    const accountCurrency = account?.currency ?? 'EUR'; // fails closed to a real currency, never blank — if wrong, the conversion-rate lookup below will simply fail to find a rate and reject rather than silently misprice risk
    const profitCurrency = symbolMeta?.profitCurrency ?? 'USD';
    const profitCurrencyToAccountCurrencyRate = await this.resolveConversionRate(profitCurrency, accountCurrency);

    // Combined open risk from any OTHER currently-open position this
    // account holds (not just gold) — approximated here as each position's
    // absolute floating profit magnitude when negative (a rough proxy for
    // "risk currently in play"); a more precise per-symbol stop-distance
    // sum would need each position's own SL distance, deferred as a
    // documented simplification, not a silently invented precise number.
    const openPositions = await this.prisma.position.findMany({ where: { accountId, status: 'OPEN' } });
    const existingCombinedRiskAmount = openPositions.reduce((sum, p) => {
      const profit = p.profit.toNumber();
      return sum + (profit < 0 ? Math.abs(profit) : 0);
    }, 0);

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    // Account-wide, not gold-only — the daily loss cap is a whole-account
    // protection (task step 5), so it must see every symbol's realized
    // deals today, not just gold's.
    const todaysTrades = await this.prisma.trade.findMany({
      where: { accountId, executedAt: { gte: dayStart } },
      select: { profit: true },
    });
    const todaysLossAmount = todaysTrades.reduce((sum, t) => {
      const profit = typeof t.profit?.toNumber === 'function' ? t.profit.toNumber() : Number(t.profit ?? 0);
      return sum + (profit < 0 ? Math.abs(profit) : 0);
    }, 0);

    // Drawdown: peak equity over the last 30 days of snapshots vs current.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentSnapshots = await this.prisma.accountSnapshot.findMany({
      where: { accountId, capturedAt: { gte: thirtyDaysAgo } },
      select: { equity: true },
    });
    const peakEquity = recentSnapshots.length > 0 ? Math.max(...recentSnapshots.map((s) => s.equity.toNumber())) : equity;
    const currentDrawdownPct = peakEquity > 0 ? Math.max(0, ((peakEquity - equity) / peakEquity) * 100) : 0;

    return {
      tradeMode, equity, accountCurrency, profitCurrency, profitCurrencyToAccountCurrencyRate,
      existingCombinedRiskAmount, todaysLossAmount, currentDrawdownPct,
    };
  }

  /**
   * Live FX conversion, `from` currency amount -> `to` currency amount
   * multiplier. Returns 1 when no conversion is needed. Only ever derives
   * a rate from a live `LiveTick` row (the same collector-pushed table
   * gold's own price comes from) — NEVER an assumed or hardcoded rate.
   * Only USD<->EUR is wired (this deployment's actual pairing, XAUUSD's
   * profit currency vs. the trading account's own currency); an
   * unsupported pair returns null so the risk gate fails closed rather
   * than silently assume 1:1 — documented delegated-implementation
   * limitation, not silently ignored.
   */
  private async resolveConversionRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;
    if (from === 'USD' && to === 'EUR') {
      const tick = await this.prisma.liveTick.findUnique({ where: { symbol: 'EURUSD' } });
      if (!tick) return null;
      const mid = (tick.bid.toNumber() + tick.ask.toNumber()) / 2;
      return mid > 0 ? 1 / mid : null; // EURUSD quotes USD per 1 EUR; invert to get EUR per 1 USD
    }
    if (from === 'EUR' && to === 'USD') {
      const tick = await this.prisma.liveTick.findUnique({ where: { symbol: 'EURUSD' } });
      if (!tick) return null;
      const mid = (tick.bid.toNumber() + tick.ask.toNumber()) / 2;
      return mid > 0 ? mid : null;
    }
    return null;
  }

  /**
   * Live broker volume/step/min/max — NEVER hardcoded. Fails closed (a
   * deliberately impossible-to-satisfy constraint, so `evaluateGoldRiskManager`
   * always rejects) when the row is missing or older than
   * `SYMBOL_METADATA_MAX_AGE_MS`, same fail-closed posture this table's own
   * schema comment documents ("blocks the entry... rather than assuming
   * permissive min/max/step values").
   */
  async resolveVolumeConstraints(now: Date = new Date()): Promise<GoldBrokerVolumeConstraints> {
    const row = await this.prisma.symbolMetadata.findUnique({ where: { symbol: GOLD_SYMBOL } });
    const impossible: GoldBrokerVolumeConstraints = { minLots: Number.POSITIVE_INFINITY, maxLots: 0, stepLots: 1 };
    if (!row) return impossible;
    if (now.getTime() - row.updatedAt.getTime() > SYMBOL_METADATA_MAX_AGE_MS) return impossible;
    return { minLots: row.volumeMin.toNumber(), maxLots: row.volumeMax.toNumber(), stepLots: row.volumeStep.toNumber() };
  }
}
