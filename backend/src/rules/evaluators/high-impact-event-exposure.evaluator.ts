import { CurrentMetrics } from '../../analytics/types/analytics.types';
import { HighImpactEventExposureParams } from '../dto/rule-parameters.dto';
import { EvaluatorExtras, RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';
import { parseForexSymbolCurrencies } from './forex-symbol';

/**
 * Market intelligence, phase 5 — risk CONTEXT, not a trading instruction:
 * "this account has significant exposure in a currency a high-impact
 * release is about to move," never "buy" or "sell." Reuses the same
 * open-positions volume-by-symbol data CONCENTRATION already computes
 * (analytics/metrics/position.metrics.ts); the only new input is
 * `extra.upcomingHighImpactEvents`, fetched by RuleEngineService.buildExtras
 * from MarketEventQueryService — this function itself does no I/O
 * (RULE_ENGINE_SPEC.md §3's "pure, no I/O, no async" box, same as every
 * other leaf evaluator).
 *
 * No upcoming high-impact event in the window, or no open positions, is
 * NOT_TRIGGERED — a known, unremarkable state, not INSUFFICIENT_DATA (same
 * convention CONCENTRATION/NO_STOP_LOSS already use for "nothing open").
 */
export function evaluateHighImpactEventExposure(
  params: HighImpactEventExposureParams,
  current: CurrentMetrics,
  extra: EvaluatorExtras,
): RuleComparisonOutcome {
  const upcomingEvents = extra.upcomingHighImpactEvents ?? [];
  const now = extra.now ?? new Date();

  if (upcomingEvents.length === 0) {
    return {
      status: RuleEvaluationStatus.NOT_TRIGGERED,
      reasonCode: 'NO_UPCOMING_HIGH_IMPACT_EVENTS',
      triggerValues: { exposures: [] },
      baselineValues: {},
    };
  }

  const exposures: {
    currency: string;
    volume: number;
    eventId: string;
    eventTitle: string;
    eventScheduledAt: string;
    minutesUntilEvent: number;
  }[] = [];

  for (const event of upcomingEvents) {
    const minutesUntilEvent = Math.round((event.scheduledAt.getTime() - now.getTime()) / 60_000);
    for (const currency of event.affectedCurrencies) {
      const volume = exposureVolumeForCurrency(current, currency);
      if (volume > 0) {
        exposures.push({
          currency,
          volume,
          eventId: event.id,
          eventTitle: event.title,
          eventScheduledAt: event.scheduledAt.toISOString(),
          minutesUntilEvent,
        });
      }
    }
  }

  const triggeringExposures = exposures.filter((e) => e.volume >= params.minimum_exposure_volume);
  const triggered = triggeringExposures.length > 0;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'EXPOSURE_ABOVE_THRESHOLD_BEFORE_HIGH_IMPACT_EVENT' : 'NO_SIGNIFICANT_EXPOSURE_BEFORE_EVENT',
    triggerValues: { exposures: triggered ? triggeringExposures : exposures },
    baselineValues: { minimum_exposure_volume: params.minimum_exposure_volume },
  };
}

/** Sums open-position volume across every symbol whose base OR quote currency matches. */
function exposureVolumeForCurrency(current: CurrentMetrics, currency: string): number {
  let total = 0;
  for (const { symbol, totalVolume } of current.position.positionVolumeBySymbol) {
    const currencies = parseForexSymbolCurrencies(symbol);
    if (currencies && currencies.includes(currency)) {
      total += totalVolume;
    }
  }
  return Math.round(total * 100) / 100;
}
