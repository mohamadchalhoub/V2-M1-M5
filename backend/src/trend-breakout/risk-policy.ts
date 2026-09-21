import { failGate, GateResult, passGate } from './gate-result';

/**
 * §10 — "Implement these as explicit, versioned initial demo-policy
 * settings." Mirrors `TrendBreakoutRiskPolicy` (schema.prisma) field for
 * field; `version` there is what a `TrendBreakoutDecision.riskPolicyVersion`
 * snapshots. Every function below is pure — no DB, no Date.now(), no
 * broker call — so it can be unit-tested against fixed numbers; the
 * DURABLE state each gate needs (daily baseline, cash-flow-adjusted high,
 * triggered flags, reserved combined risk) is read/written by
 * `risk-state.service.ts`, never by this file.
 */
export interface RiskPolicyConfig {
  version: number;
  maxTradeRiskPct: number;
  maxCombinedRiskPct: number;
  dailyLossPct: number;
  drawdownPct: number;
  maxSpreadPctOfD: number;
  maxQuoteAgeSeconds: number;
}

/** §10's own stated initial numbers — the bootstrap seed for `TrendBreakoutRiskPolicy` row version 1, never re-read after that row exists. */
export const DEFAULT_RISK_POLICY: Omit<RiskPolicyConfig, 'version'> = {
  maxTradeRiskPct: 0.5,
  maxCombinedRiskPct: 1,
  dailyLossPct: 2,
  drawdownPct: 5,
  maxSpreadPctOfD: 10,
  maxQuoteAgeSeconds: 5,
};

/**
 * Monetary risk at the initial stop, in the instrument's PROFIT currency
 * (e.g. USD for both EURUSD and XAUUSD on a standard MT5 contract spec) —
 * `conversionRateToAccountCcy` converts that into the account's own
 * currency (this deployment's demo account is EUR-denominated — see
 * `currency-conversion.ts`). `contractSize` and the conversion rate both
 * come from `SymbolMetadata`/a live quote; this function fails closed
 * (returns null) rather than silently assume 1:1 if either is missing —
 * callers must treat null as "cannot compute, block the entry" (§10 — "if
 * required risk inputs or account state are missing, block entries").
 */
export function estimateStopRiskAmount(input: { volumeLots: number; contractSize: number; stopDistancePrice: number; conversionRateToAccountCcy: number | null }): number | null {
  if (input.conversionRateToAccountCcy === null) return null;
  if (!(input.volumeLots > 0) || !(input.contractSize > 0) || !(input.stopDistancePrice > 0) || !(input.conversionRateToAccountCcy > 0)) return null;
  return input.volumeLots * input.contractSize * input.stopDistancePrice * input.conversionRateToAccountCcy;
}

export function evaluateTradeRiskGate(input: { estimatedRiskAmount: number; accountEquity: number; maxTradeRiskPct: number }): GateResult {
  const limit = (input.maxTradeRiskPct / 100) * input.accountEquity;
  if (input.estimatedRiskAmount > limit) {
    return failGate('trade_risk_limit', `Estimated stop risk ${input.estimatedRiskAmount.toFixed(2)} exceeds ${input.maxTradeRiskPct}% of equity (${limit.toFixed(2)}) — skipping this trade (volume is NOT reduced).`);
  }
  return passGate('trade_risk_limit', `Estimated stop risk ${input.estimatedRiskAmount.toFixed(2)} <= ${input.maxTradeRiskPct}% of equity (${limit.toFixed(2)}).`);
}

/**
 * §10 — "For combined risk, conservatively reserve each open strategy
 * position's original estimated stop risk plus any unresolved entry
 * reservations. Do not release the reservation until closure is
 * confirmed." `reservedRiskAmounts` is the caller's (risk-state.service.ts)
 * job to assemble correctly from every currently-locked slot
 * (`TrendBreakoutSlotLock` join `TrendBreakoutDecision.estimatedStopRiskAmount`)
 * — this function just sums what it's given and compares to the limit.
 */
export function evaluateCombinedRiskGate(input: { reservedRiskAmounts: number[]; newRiskAmount: number; accountEquity: number; maxCombinedRiskPct: number }): GateResult {
  const alreadyReserved = input.reservedRiskAmounts.reduce((a, b) => a + b, 0);
  const combined = alreadyReserved + input.newRiskAmount;
  const limit = (input.maxCombinedRiskPct / 100) * input.accountEquity;
  if (combined > limit) {
    return failGate(
      'combined_risk_limit',
      `Combined estimated stop risk ${combined.toFixed(2)} (${alreadyReserved.toFixed(2)} already reserved + ${input.newRiskAmount.toFixed(2)} new) exceeds ${input.maxCombinedRiskPct}% of equity (${limit.toFixed(2)}).`,
    );
  }
  return passGate('combined_risk_limit', `Combined estimated stop risk ${combined.toFixed(2)} <= ${input.maxCombinedRiskPct}% of equity (${limit.toFixed(2)}).`);
}

/**
 * §10 daily loss — "Use the Beirut calendar day. Include realized and
 * unrealized equity changes. Adjust for deposits/withdrawals so cash
 * transfers are not trading profit/loss. Once triggered, block entries
 * until the next Beirut day." `dailyNetCashFlow` is the sum of deposits
 * (positive) / withdrawals (negative) observed since `dailyBaselineEquity`
 * was captured (risk-state.service.ts's job to track from account-snapshot
 * balance deltas that aren't explained by trading P&L) — subtracted out so
 * a deposit can never look like a trading gain that offsets a real loss,
 * and a withdrawal can never look like an additional loss.
 */
export function evaluateDailyLossGate(input: { currentEquity: number; dailyBaselineEquity: number; dailyNetCashFlow: number; dailyLossPct: number; alreadyTriggered: boolean }): GateResult {
  if (input.alreadyTriggered) {
    return failGate('daily_loss_limit', 'Daily loss threshold was already triggered today (Beirut calendar day) — blocked until the next Beirut day.');
  }
  const tradingPnl = input.currentEquity - input.dailyBaselineEquity - input.dailyNetCashFlow;
  const threshold = -(input.dailyLossPct / 100) * input.dailyBaselineEquity;
  if (tradingPnl <= threshold) {
    return failGate('daily_loss_limit', `Cash-flow-adjusted trading P&L today is ${tradingPnl.toFixed(2)}, at or beyond the -${input.dailyLossPct}% threshold (${threshold.toFixed(2)}) — triggering the daily loss block.`);
  }
  return passGate('daily_loss_limit', `Cash-flow-adjusted trading P&L today is ${tradingPnl.toFixed(2)}, within the -${input.dailyLossPct}% threshold (${threshold.toFixed(2)}).`);
}

/**
 * §10 drawdown — "Maintain a durable cash-flow-adjusted equity high. Once
 * triggered, block new entries until explicit user review/reset."
 * `cashFlowAdjustedHigh` is maintained by risk-state.service.ts (monotonic
 * high-water mark of cash-flow-adjusted equity, never decreasing except by
 * explicit reset) — this function only compares current equity against it.
 */
export function evaluateDrawdownGate(input: { currentEquity: number; cashFlowAdjustedHigh: number; drawdownPct: number; alreadyTriggered: boolean }): GateResult {
  if (input.alreadyTriggered) {
    return failGate('drawdown_limit', 'Drawdown threshold was already triggered — blocked until an explicit user review/reset.');
  }
  const drawdownPct = input.cashFlowAdjustedHigh > 0 ? ((input.cashFlowAdjustedHigh - input.currentEquity) / input.cashFlowAdjustedHigh) * 100 : 0;
  if (drawdownPct >= input.drawdownPct) {
    return failGate('drawdown_limit', `Equity is ${drawdownPct.toFixed(2)}% below its cash-flow-adjusted high (${input.cashFlowAdjustedHigh.toFixed(2)}) — at or beyond the ${input.drawdownPct}% threshold, triggering the drawdown block.`);
  }
  return passGate('drawdown_limit', `Equity is ${drawdownPct.toFixed(2)}% below its cash-flow-adjusted high — within the ${input.drawdownPct}% threshold.`);
}

export function evaluateSpreadGate(input: { spreadPrice: number; stopDistancePrice: number; maxSpreadPctOfD: number }): GateResult {
  const maxSpread = (input.maxSpreadPctOfD / 100) * input.stopDistancePrice;
  if (input.spreadPrice > maxSpread) {
    return failGate('max_spread', `Current spread ${input.spreadPrice.toFixed(6)} exceeds ${input.maxSpreadPctOfD}% of D (${maxSpread.toFixed(6)}).`);
  }
  return passGate('max_spread', `Current spread ${input.spreadPrice.toFixed(6)} <= ${input.maxSpreadPctOfD}% of D (${maxSpread.toFixed(6)}).`);
}

export function evaluateQuoteAgeGate(input: { quoteAgeMs: number; maxQuoteAgeSeconds: number }): GateResult {
  const maxAgeMs = input.maxQuoteAgeSeconds * 1000;
  if (input.quoteAgeMs > maxAgeMs) {
    return failGate('max_quote_age', `Quote is ${(input.quoteAgeMs / 1000).toFixed(1)}s old, exceeding the ${input.maxQuoteAgeSeconds}s maximum.`);
  }
  return passGate('max_quote_age', `Quote is ${(input.quoteAgeMs / 1000).toFixed(1)}s old (<= ${input.maxQuoteAgeSeconds}s).`);
}

/** §10's last line — "if required risk inputs or account state are missing, block entries." A single, reusable fail-closed gate for every "we don't actually know X" case (missing equity, missing symbol metadata, missing conversion rate, etc.) so every caller phrases this the same way. */
export function missingDataGate(gate: string, whatIsMissing: string): GateResult {
  return failGate(gate, `Required input missing: ${whatIsMissing} — failing closed (blocking this entry) rather than assuming a safe default.`);
}

/** Cash-flow-adjusted running equity high — monotonic non-decreasing except by an explicit reset (never automatic). `currentCashFlowAdjustedEquity` is `currentEquity - cumulativeNetCashFlow` (deposits/withdrawals removed), computed by the caller. */
export function updateCashFlowAdjustedHigh(previousHigh: number, currentCashFlowAdjustedEquity: number): number {
  return Math.max(previousHigh, currentCashFlowAdjustedEquity);
}
