import { Injectable } from '@nestjs/common';
import { MarketEventQueryService } from '../market-events/market-event-query.service';
import { parseForexSymbolCurrencies } from '../rules/evaluators/forex-symbol';
import { PrismaService } from '../prisma/prisma.service';
import { MarketContext } from './ai-provider.interface';

// Descriptive context for the AI, not a rule trigger condition — so these
// windows are deliberately broader/fixed rather than per-rule configurable
// (HIGH_IMPACT_EVENT_EXPOSURE's own minutes_before is the trigger; this is
// "what's generally on the horizon," for narration).
const EVENT_LOOKAHEAD_MINUTES = 24 * 60;
const NEWS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Reliability pass — this system only ever monitors EURUSD (the same
// single-symbol scope historical-pattern-summary.service.ts's own SYMBOL
// constant and every technical-analysis service use), so EUR/USD news and
// calendar events are always relevant here, not just when the account
// happens to be holding a position right now. Before this, `exposedCurrencies`
// was derived ONLY from open positions and both MarketEventQueryService
// methods short-circuit to an empty array for an empty currency list — so
// with zero open positions (the common case for a demo/testing account, and
// possible in live trading too) the AI received no news/calendar context at
// all despite Finnhub/FRED actively ingesting real data (found in a live
// system audit this session). Open positions can still widen this beyond
// EUR/USD (e.g. a future non-EURUSD symbol), so their currencies are still
// added on top, not replaced.
const MONITORED_CURRENCIES = ['EUR', 'USD'];

/**
 * Market intelligence, AI phase 6 — builds `AlertContext.marketContext`
 * fresh at AI-analysis time (same posture as `similarPastEvents`,
 * ai/similar-past-events.ts: supplementary context about the world right
 * now, not a record of what caused the alert, so it's exempt from the
 * "never a fresh query, only Alert's own frozen data" rule that still
 * governs `triggerValues`/`baselineSnapshot`). Currencies always include
 * `MONITORED_CURRENCIES` (EUR/USD — the one pair this whole system covers)
 * plus whatever this account's own currently open positions add on top, so
 * a trader sees EURUSD context regardless of whether they're holding a
 * position right now, and anything from a future non-EURUSD symbol too.
 */
@Injectable()
export class MarketContextBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketEventQuery: MarketEventQueryService,
  ) {}

  async build(accountId: string, now: Date = new Date()): Promise<MarketContext> {
    const openPositions = await this.prisma.position.findMany({
      where: { accountId, status: 'OPEN' },
      select: { symbol: true },
    });

    const currencySet = new Set<string>(MONITORED_CURRENCIES);
    for (const { symbol } of openPositions) {
      const pair = parseForexSymbolCurrencies(symbol);
      if (pair) {
        currencySet.add(pair[0]);
        currencySet.add(pair[1]);
      }
    }
    const exposedCurrencies = [...currencySet];

    const [upcomingEvents, recentNews] = await Promise.all([
      this.marketEventQuery.findUpcomingHighImpactEvents(exposedCurrencies, now, EVENT_LOOKAHEAD_MINUTES),
      this.marketEventQuery.findRecentNews(exposedCurrencies, new Date(now.getTime() - NEWS_LOOKBACK_MS)),
    ]);

    return {
      exposedCurrencies,
      upcomingHighImpactEvents: upcomingEvents.map((e) => ({
        id: e.id,
        title: e.title,
        scheduledAt: e.scheduledAt.toISOString(),
        affectedCurrencies: e.affectedCurrencies,
      })),
      recentNews: recentNews.map((n) => ({
        id: n.id,
        title: n.title,
        scheduledAt: n.scheduledAt.toISOString(),
        sentiment: n.sentiment,
        sourceUrl: n.sourceUrl,
      })),
    };
  }
}
