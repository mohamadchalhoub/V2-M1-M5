import { priceDistanceInPoints } from '../technical-analysis/point-value';
import { AutonomousRulesConfig } from './autonomous-rules.config';
import { AutonomousAiAction, AutonomousAiDecision, RawAutonomousAiDecision } from './autonomous-ai-decision.types';
import { MAX_POSITION_SIZE_LOTS, SL_TP_TOLERANCE_POINTS } from './safety-constants';

const VALID_ACTIONS: readonly AutonomousAiAction[] = ['OPEN_BUY', 'OPEN_SELL', 'CLOSE_POSITION', 'HOLD'];

/**
 * The plan's explicit requirement: "enforced by validation, not just prompt
 * wording." Every numeric value the AI produced is independently
 * recomputed and checked here against the SAME config the mechanical rule
 * engine used — a response that fails ANY of these checks is rejected
 * outright (never silently corrected/clamped), and the caller logs it as a
 * rejected AI decision, never places anything based on it.
 */
export function validateAutonomousAiDecision(raw: RawAutonomousAiDecision, config: AutonomousRulesConfig): AutonomousAiDecision {
  if (typeof raw.action !== 'string' || !VALID_ACTIONS.includes(raw.action as AutonomousAiAction)) {
    throw new Error(`AI response "action" must be one of ${VALID_ACTIONS.join(', ')}, got ${JSON.stringify(raw.action)}`);
  }
  const action = raw.action as AutonomousAiAction;

  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    throw new Error(`AI response "confidence" must be a number between 0 and 1, got ${JSON.stringify(raw.confidence)}`);
  }

  if (typeof raw.reasoning !== 'string' || raw.reasoning.trim() === '') {
    throw new Error('AI response "reasoning" must be a non-empty string');
  }

  if (action === 'CLOSE_POSITION') {
    // No execution capability exists yet — there is never a real position for this system to close.
    throw new Error('AI returned CLOSE_POSITION, but no execution module exists in this phase — rejecting as invalid for the current system state.');
  }

  if (action === 'HOLD') {
    return { action, confidence: raw.confidence, entryPrice: null, stopLoss: null, takeProfit: null, positionSize: null, reasoning: raw.reasoning };
  }

  // OPEN_BUY / OPEN_SELL — every numeric field is required and exact.
  for (const field of ['entry_price', 'stop_loss', 'take_profit', 'position_size'] as const) {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field] as number)) {
      throw new Error(`AI response "${field}" must be a finite number when action is ${action}, got ${JSON.stringify(raw[field])}`);
    }
  }
  const entryPrice = raw.entry_price as number;
  const stopLoss = raw.stop_loss as number;
  const takeProfit = raw.take_profit as number;
  const positionSize = raw.position_size as number;

  if (positionSize !== MAX_POSITION_SIZE_LOTS) {
    throw new Error(`AI response "position_size" must be exactly ${MAX_POSITION_SIZE_LOTS}, got ${positionSize}`);
  }

  const actualSlDistance = priceDistanceInPoints(entryPrice, stopLoss);
  const actualTpDistance = priceDistanceInPoints(entryPrice, takeProfit);

  if (Math.abs(actualSlDistance - config.stopLossPoints) > SL_TP_TOLERANCE_POINTS) {
    throw new Error(`AI response "stop_loss" (${stopLoss}) is ${actualSlDistance.toFixed(1)}pt from entry — expected exactly ${config.stopLossPoints}pt (±${SL_TP_TOLERANCE_POINTS})`);
  }
  if (Math.abs(actualTpDistance - config.takeProfitPoints) > SL_TP_TOLERANCE_POINTS) {
    throw new Error(`AI response "take_profit" (${takeProfit}) is ${actualTpDistance.toFixed(1)}pt from entry — expected exactly ${config.takeProfitPoints}pt (±${SL_TP_TOLERANCE_POINTS})`);
  }

  // Direction sanity: a BUY's stop must be below entry and target above (and the mirror for SELL) —
  // catches an AI that got the exact distances right but on the wrong side, which the distance
  // checks above alone wouldn't catch.
  if (action === 'OPEN_BUY' && !(stopLoss < entryPrice && takeProfit > entryPrice)) {
    throw new Error(`AI response for OPEN_BUY must have stop_loss below and take_profit above entry_price (entry=${entryPrice}, sl=${stopLoss}, tp=${takeProfit})`);
  }
  if (action === 'OPEN_SELL' && !(stopLoss > entryPrice && takeProfit < entryPrice)) {
    throw new Error(`AI response for OPEN_SELL must have stop_loss above and take_profit below entry_price (entry=${entryPrice}, sl=${stopLoss}, tp=${takeProfit})`);
  }

  return { action, confidence: raw.confidence, entryPrice, stopLoss, takeProfit, positionSize, reasoning: raw.reasoning };
}
