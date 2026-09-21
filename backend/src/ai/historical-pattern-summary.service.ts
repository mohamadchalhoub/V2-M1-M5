import { Injectable } from '@nestjs/common';
import { RoundTripTrade, TradeAlignmentService } from '../historical-charts/trade-alignment.service';
import { HistoricalPatternContext, HistoricalPatternSide } from './ai-provider.interface';

// EURUSD only — the same single-symbol scope the historical chart
// reconstruction phase itself uses (historical-charts.controller.ts's own
// SYMBOL constant); nothing here widens that scope.
const SYMBOL = 'EURUSD';

// Sample-size thresholds for the confidence label — deliberately
// conservative and documented here as the one place they're defined, same
// spirit as RULE_ENGINE_SPEC.md's own explicit thresholds. A future rule or
// prompt change that wants a different cutoff changes it here, not by
// guessing at "enough data" inline.
const MEDIUM_CONFIDENCE_SAMPLE_SIZE = 20;
const HIGH_CONFIDENCE_SAMPLE_SIZE = 100;

function confidenceFor(sampleSize: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (sampleSize >= HIGH_CONFIDENCE_SAMPLE_SIZE) return 'HIGH';
  if (sampleSize >= MEDIUM_CONFIDENCE_SAMPLE_SIZE) return 'MEDIUM';
  return 'LOW';
}

/**
 * Audit finding (reconciliation session): classifies and averages by
 * NET P/L (`netProfit` — profit + commission + swap), not the OUT deal's
 * raw `profit` field. A win-rate/average-P&L summary handed to the AI as
 * "historical pattern" should reflect what the trader actually kept, not a
 * pre-cost figure a nonzero swap can silently overstate. Breakeven
 * (`netProfit === 0` exactly) counts toward neither wins nor losses,
 * consistent with the independent audit's own net-position reconciliation
 * of this account's real trade history.
 */
function summarizeSide(trips: RoundTripTrade[]): HistoricalPatternSide {
  const sampleSize = trips.length;
  if (sampleSize === 0) {
    return { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' };
  }
  const wins = trips.filter((t) => t.netProfit > 0).length;
  const totalPnl = trips.reduce((sum, t) => sum + t.netProfit, 0);
  return {
    sampleSize,
    winRate: wins / sampleSize,
    averagePnl: totalPnl / sampleSize,
    confidence: confidenceFor(sampleSize),
  };
}

/**
 * AI provider phase — the one place that turns the trader's OWN closed
 * EURUSD trade history into the small, deterministic, aggregate-only
 * summary `AlertContext` carries as `historicalPatternContext`. Deliberately
 * NOT scoped to the alert's own account (`TradeAlignmentService.getAllRoundTrips`,
 * not `getRoundTrips`) — per the user's own framing, this represents "the
 * data history of mine," regardless of which account is currently being
 * monitored live: an account with little trading history of its own (e.g.
 * a fresh demo account) still benefits from the trader's real historical
 * pattern imported separately (XTB Excel history), and a future real
 * account's own trades blend into the same running statistic automatically
 * rather than starting over at zero. Reuses TradeAlignmentService rather
 * than re-pairing IN/OUT deals a second time. Descriptive only
 * (RECONSTRUCTION spec §7/§9's own posture: sample size and win rate, never
 * a claim about future direction) — the AI is told explicitly, in the
 * prompt, that these are historical statistics, not predictions.
 */
@Injectable()
export class HistoricalPatternSummaryService {
  constructor(private readonly tradeAlignment: TradeAlignmentService) {}

  async build(): Promise<HistoricalPatternContext> {
    const roundTrips = await this.tradeAlignment.getAllRoundTrips(SYMBOL);
    const buyTrips = roundTrips.filter((t) => t.side === 'BUY');
    const sellTrips = roundTrips.filter((t) => t.side === 'SELL');
    return {
      symbol: SYMBOL,
      buy: summarizeSide(buyTrips),
      sell: summarizeSide(sellTrips),
    };
  }
}
