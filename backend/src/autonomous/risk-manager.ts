import { priceDistanceInPoints } from '../technical-analysis/point-value';
import { AutonomousRulesConfig } from './autonomous-rules.config';
import { AutonomousAiDecision } from './autonomous-ai-decision.types';
import { MAX_POSITION_SIZE_LOTS, SL_TP_TOLERANCE_POINTS } from './safety-constants';

/**
 * Mirrors MT5's own `ACCOUNT_TRADE_MODE_*` enum (`account_info().trade_mode`)
 * — deliberately a closed set of exactly what MT5 reports, not a boolean
 * "isDemo," so an unexpected value (a broker-specific mode this system has
 * never seen) fails the type check rather than being silently coerced to
 * one side or the other.
 */
export type AccountTradeMode = 'DEMO' | 'REAL' | 'CONTEST';

export interface RiskManagerAccountInfo {
  tradeMode: AccountTradeMode;
}

export interface RiskManagerInput {
  decision: AutonomousAiDecision;
  accountInfo: RiskManagerAccountInfo;
  ordersPlacedToday: number;
  killSwitchActive: boolean;
  config: AutonomousRulesConfig;
}

export interface RiskManagerVerdict {
  approved: boolean;
  rejectionReason: string | null;
}

/**
 * Plan §4 — deterministic, code, not AI, not `.env`-configurable for the
 * absolute bounds: enforces the safety non-negotiables from plan §1 plus
 * the friend's own one-order-per-day rule, and NOTHING else — no
 * independently-invented daily-loss cap, circuit breaker, or trading-hours
 * window layered on top (AUTONOMOUS_DEMO_TRADING_PLAN.md §2's explicit
 * design commitment). Sits between the AI decision layer (Phase 4) and
 * whatever execution module eventually calls MT5's `order_send` — no such
 * module exists in this repo yet, so this function has no live caller yet,
 * same as every other pipeline stage was built and unit-tested ahead of
 * its own orchestration layer this session (weekly-range-levels.service.ts,
 * level-confirmation.ts, etc.).
 *
 * Deliberately re-derives and re-checks everything
 * `validate-autonomous-ai-decision.ts` already checked (exact SL/TP
 * distance, position size, correct side) — defense in depth, per the
 * plan's own instruction that this layer must never simply trust that an
 * earlier layer already validated something. The one check ONLY this
 * layer can make (no upstream layer has the data) is the demo-account
 * gate — the single most safety-critical line in this entire project.
 */
export function evaluateRiskManager(input: RiskManagerInput): RiskManagerVerdict {
  const { decision, accountInfo, ordersPlacedToday, killSwitchActive, config } = input;

  if (killSwitchActive) {
    return { approved: false, rejectionReason: 'Kill switch is active — no new orders permitted.' };
  }

  // The single most safety-critical check in this project (plan §1, rule 1
  // of the non-negotiables): never trade a real-money account, full stop.
  if (accountInfo.tradeMode !== 'DEMO') {
    return {
      approved: false,
      rejectionReason: `Refusing to trade: account trade_mode is "${accountInfo.tradeMode}", not DEMO. This is an absolute, non-negotiable safety rule — not something any config or decision can override.`,
    };
  }

  if (decision.action === 'HOLD') {
    return { approved: true, rejectionReason: null };
  }

  if (ordersPlacedToday >= config.maxOrdersPerDay) {
    return {
      approved: false,
      rejectionReason: `Friend's Rule 3: ${ordersPlacedToday} order(s) already placed today (max ${config.maxOrdersPerDay}).`,
    };
  }

  if (decision.entryPrice === null || decision.stopLoss === null || decision.takeProfit === null || decision.positionSize === null) {
    return { approved: false, rejectionReason: `${decision.action} is missing a required price/size field — refusing to submit an incomplete order.` };
  }

  if (decision.positionSize !== MAX_POSITION_SIZE_LOTS) {
    return { approved: false, rejectionReason: `Position size ${decision.positionSize} does not equal the hardcoded max of ${MAX_POSITION_SIZE_LOTS} lots.` };
  }

  const slDistance = priceDistanceInPoints(decision.entryPrice, decision.stopLoss);
  const tpDistance = priceDistanceInPoints(decision.entryPrice, decision.takeProfit);
  if (Math.abs(slDistance - config.stopLossPoints) > SL_TP_TOLERANCE_POINTS) {
    return { approved: false, rejectionReason: `Stop-loss distance ${slDistance.toFixed(1)}pt does not match the required ${config.stopLossPoints}pt.` };
  }
  if (Math.abs(tpDistance - config.takeProfitPoints) > SL_TP_TOLERANCE_POINTS) {
    return { approved: false, rejectionReason: `Take-profit distance ${tpDistance.toFixed(1)}pt does not match the required ${config.takeProfitPoints}pt.` };
  }

  if (decision.action === 'OPEN_BUY' && !(decision.stopLoss < decision.entryPrice && decision.takeProfit > decision.entryPrice)) {
    return { approved: false, rejectionReason: 'OPEN_BUY stop-loss/take-profit are on the wrong side of entry.' };
  }
  if (decision.action === 'OPEN_SELL' && !(decision.stopLoss > decision.entryPrice && decision.takeProfit < decision.entryPrice)) {
    return { approved: false, rejectionReason: 'OPEN_SELL stop-loss/take-profit are on the wrong side of entry.' };
  }

  return { approved: true, rejectionReason: null };
}
