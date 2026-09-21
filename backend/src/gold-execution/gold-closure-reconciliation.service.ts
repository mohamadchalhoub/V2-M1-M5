import { Injectable, Logger } from '@nestjs/common';
import { Platform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingDealDto } from '../collector-ingress/dto/trades.dto';
import { GOLD_MAGIC_NUMBER, GOLD_SYMBOL } from './gold-safety-constants';
import { GoldTelegramService } from './gold-telegram.service';
import { GoldAiSummaryService } from './gold-ai-summary.service';

/**
 * Task item B — broker-confirmed closures + net P&L, including partial
 * closes. Deliberately NOT a queued job (task's own instruction): runs as a
 * plain reconciliation step on every `/collector/trades` ingestion cycle,
 * driven by whatever cadence the collector already pushes deal data on
 * (`CollectorIngressController.postTrades`, right after
 * `TradingDataService.upsertDeals` persists the real `Trade` rows this
 * reads from) — same "the collector pushes, the pipeline reacts
 * synchronously" posture as rule evaluation on the same endpoint.
 *
 * MT5 reports one `Trade` (deal) row per close/partial-close, with
 * `dealEntry` OUT (close against an existing position), OUT_BY (closed by
 * an opposite position, hedging-mode) or INOUT (netting-mode: the same deal
 * both closes the old net position and opens a new one) — all three carry a
 * real realized `profit` for the portion closed, so all three count as a
 * "closure" here. IN (opening a position) is never a closure.
 *
 * Full vs partial is read off `Position.status` for the deal's
 * `positionId`, AFTER the snapshot pipeline (`replaceOpenPositions`) has
 * had a chance to mark it CLOSED — since snapshot and trade pushes are
 * separate, unordered endpoint calls, a position that is still reported
 * OPEN at the moment this runs is read as "partial" (more volume remains);
 * one that is CLOSED, or not found at all (already pruned, or this
 * collector never reported it open), is read as "full". This is a
 * best-effort classification off the data actually available, not a
 * guarantee against every possible interleaving.
 *
 * Durable dedup: one `GoldTelegramNotification` row per closure, keyed by
 * the deal's own `externalTradeId` (MT5 deal ticket) — the same natural,
 * already-idempotent identity `TradingDataService.upsertDeals` itself keys
 * on, persisted in Postgres so a process restart never re-sends or
 * silently drops a closure notification.
 */
@Injectable()
export class GoldClosureReconciliationService {
  private readonly logger = new Logger(GoldClosureReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly goldTelegram: GoldTelegramService,
    private readonly goldAiSummary: GoldAiSummaryService,
  ) {}

  async reconcile(accountId: string, platform: Platform, deals: IncomingDealDto[]): Promise<void> {
    // Task item 4 — "scope notifications to THIS strategy/account, not
    // merely symbol=XAUUSD." A manual XAUUSD trade, or a different bot
    // trading gold on the same account, would otherwise be mislabeled as
    // this strategy's own closure. MT5 deals carry a `magic` number
    // (collector's mt5_client.py passes the full deal `_asdict()` through as
    // `raw`, which includes it) — only deals matching GOLD_MAGIC_NUMBER
    // belong to this strategy. A deal with symbol=XAUUSD but a magic that
    // does NOT match is deliberately skipped (not "assumed ours"); one with
    // magic missing entirely (an old collector version, or a manual trade
    // with no EA/magic at all) is ALSO skipped, logged, and never silently
    // treated as belonging to this strategy — ownership must be positively
    // confirmed, not assumed by default.
    const ownDeals = deals.filter((d) => d.symbol.toUpperCase() === GOLD_SYMBOL);
    const closingDeals = ownDeals.filter((d) => {
      if (!isOwnMagic(d)) {
        this.logger.debug(`deal ${d.externalTradeId}: XAUUSD but magic does not match this strategy (or is absent) — not this strategy's closure, skipping`);
        return false;
      }
      return d.dealEntry === 'OUT' || d.dealEntry === 'OUT_BY' || d.dealEntry === 'INOUT';
    });

    for (const deal of closingDeals) {
      try {
        await this.notifyClosure(accountId, platform, deal);
      } catch (err) {
        this.logger.error(
          `closure reconciliation failed for deal ${deal.externalTradeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async notifyClosure(accountId: string, platform: Platform, deal: IncomingDealDto): Promise<void> {
    let isPartial = false;
    if (deal.positionId) {
      const position = await this.prisma.position.findUnique({
        where: { accountId_platform_externalPositionId: { accountId, platform, externalPositionId: deal.positionId } },
        select: { status: true },
      });
      isPartial = position?.status === 'OPEN';
    }

    // Per-DEAL net (this closing deal only): profit + this deal's own
    // commission + swap — what THIS closing event itself realized.
    const perDealNetPnl = deal.profit + deal.commission + deal.swap;

    // Task item 4 — "distinguish per-deal P&L from total position net P&L,
    // including entry-side commissions." Many brokers charge commission on
    // the ENTRY (IN) deal, not the exit — summing only the closing deal
    // would silently omit it. Sums profit+commission+swap across EVERY
    // Trade row sharing this positionId (entry + every close-so-far),
    // already persisted by TradingDataService.upsertDeals before this runs.
    // For a FULL close this is the true lifetime total; for a PARTIAL close
    // it's the total realized SO FAR (there is no way to know the
    // still-open remainder's eventual P&L).
    let positionNetPnl: number | null = null;
    if (deal.positionId) {
      const allDealsForPosition = await this.prisma.trade.findMany({
        where: { accountId, platform, positionId: deal.positionId },
        select: { profit: true, commission: true, swap: true },
      });
      positionNetPnl = allDealsForPosition.reduce((sum, d) => sum + d.profit.toNumber() + d.commission.toNumber() + d.swap.toNumber(), 0);
    }

    const eventType = isPartial ? 'PARTIAL_CLOSE' : 'FULL_CLOSE';
    const dedupKey = `closure:${deal.externalTradeId}`;

    const text =
      `GOLD DEMO — ${isPartial ? 'partial close' : 'position closed'}. ` +
      `ticket=${deal.externalTradeId} position=${deal.positionId ?? 'n/a'} side=${deal.side} volume=${deal.volume} ` +
      `closePrice=${deal.price} thisDealNetPnl=${perDealNetPnl.toFixed(2)} (profit=${deal.profit} commission=${deal.commission} swap=${deal.swap}) ` +
      (positionNetPnl !== null ? `positionNetPnlSoFar=${positionNetPnl.toFixed(2)} (entry+all closes, incl. entry-side commission) ` : '') +
      `executedAt=${deal.executedAt}`;

    await this.goldTelegram.notify(eventType, dedupKey, text);
    // Fire-and-forget — must never delay or block the Telegram alert above.
    void this.goldAiSummary.generateForEvent(eventType, deal.executedAt, text);
  }
}

/** True only when the deal's raw MT5 payload carries a `magic` matching this strategy's own — never assumed true when absent. */
function isOwnMagic(deal: IncomingDealDto): boolean {
  const raw = deal.raw as Record<string, unknown> | undefined;
  const magic = raw?.magic;
  return typeof magic === 'number' && magic === GOLD_MAGIC_NUMBER;
}
