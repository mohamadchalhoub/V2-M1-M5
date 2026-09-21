import { HistoricalPatternContext } from '../ai/ai-provider.interface';
import { RecentMarketNews, UpcomingMarketEvent } from '../market-events/market-event-query.service';
import { CurrentPrice, RuleLevelType } from './autonomous-rule-engine.service';
import { LevelState } from './level-confirmation';
import { WeeklyRangeLevels } from './weekly-range-levels.service';

export type AutonomousAiAction = 'OPEN_BUY' | 'OPEN_SELL' | 'CLOSE_POSITION' | 'HOLD';

/** The provider's raw parsed JSON, before validation — field names match the plan's own schema exactly (snake_case, as asked of the model). */
export interface RawAutonomousAiDecision {
  action?: unknown;
  confidence?: unknown;
  entry_price?: unknown;
  stop_loss?: unknown;
  take_profit?: unknown;
  position_size?: unknown;
  reasoning?: unknown;
}

/** After validation — camelCase, matching this codebase's own convention once past the wire boundary. Narrower than `AutonomousAiAction`: `validateAutonomousAiDecision` always throws on `CLOSE_POSITION` (no execution module exists to have a position to close) rather than ever returning it, so a validated decision's action is never that value. */
export interface AutonomousAiDecision {
  action: 'OPEN_BUY' | 'OPEN_SELL' | 'HOLD';
  confidence: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  positionSize: number | null;
  reasoning: string;
}

/**
 * Everything the AI is given — assembled ONLY when the deterministic rule
 * engine (`evaluateAutonomousRule`) has ALREADY found a valid mechanical
 * candidate (a confluence-confirmed, touched-and-retraced level, no
 * volatility spike, one order/day not yet used). This is a practical
 * gating choice, not a hint to the AI about what to decide — the AI is
 * given the same raw signals the mechanical engine used and reasons about
 * them independently (plan §3), never told "the rule engine says BUY."
 * Gating this way keeps the AI strictly a confirm-or-veto layer over
 * mechanically-valid setups (never the originator of a trade idea — see
 * AUTONOMOUS_DEMO_TRADING_PLAN.md §13.1), and keeps real API call volume to
 * roughly one per mechanical candidate rather than one per tick.
 */
export interface AutonomousAiContext {
  now: Date;
  currentPrice: CurrentPrice;
  h4Levels: WeeklyRangeLevels;
  d1Levels: WeeklyRangeLevels | null;
  supportState: LevelState;
  resistanceState: LevelState;
  mechanicalCandidateLevel: RuleLevelType;
  historicalPattern: HistoricalPatternContext;
  upcomingEvents: UpcomingMarketEvent[];
  recentNews: RecentMarketNews[];
  ordersPlacedToday: number;
}

export interface AutonomousAiProvider {
  /**
   * Stable identifier of the underlying model provider — 'gemini' / 'groq' /
   * 'openrouter' for the leaf providers. Audit finding: `AutonomousFallbackProvider`
   * (autonomous-ai-fallback-provider.ts) mutates this to whichever leaf
   * provider actually answered the MOST RECENT `decide()` call, so a caller
   * reading it right after a successful `decide()` gets the true source —
   * fixing a confirmed defect where the decision log always recorded
   * "gemini" even when Gemini's quota was exhausted and Groq or OpenRouter
   * answered instead.
   */
  providerName: string;
  decide(context: AutonomousAiContext): Promise<RawAutonomousAiDecision>;
}
