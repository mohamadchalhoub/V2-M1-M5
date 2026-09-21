import { AiAnalysisResult, NewsSentimentLevel, RecommendedAction, RiskLevel } from './ai-provider.interface';

const RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const NEWS_SENTIMENT_LEVELS: readonly NewsSentimentLevel[] = ['NEGATIVE', 'NEUTRAL', 'POSITIVE', 'MIXED'];
// The one closed set market intelligence phase 6 permits — every value here
// is a risk-management POSTURE, never a trade direction. Anything outside
// this exact list is rejected, not coerced or clamped to the nearest one.
const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = [
  'MONITOR',
  'REDUCE_RISK',
  'AVOID_NEW_EXPOSURE',
  'REVIEW_POSITION',
];

/**
 * AI_INTEGRATION_SPEC.md §3 (original fields) + market intelligence phase 6
 * (market_risk/exposure_risk/event_risk/news_sentiment/confidence/
 * assessment/recommended_action) — a provider's raw response is parsed
 * against this exact shape before it can go anywhere near Telegram or
 * Postgres; a response that doesn't fit it is rejected here, the same as
 * any other schema-validated boundary in this system
 * (rules/dto/validate-rule-parameters.ts is the sibling pattern for rule
 * parameters). Deliberately hand-written rather than a new validation-library
 * dependency — the shape is small and flat enough that a library would add
 * more surface than it saves.
 */
export function validateAiAnalysisResult(value: unknown): AiAnalysisResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('AI response is not an object');
  }
  const v = value as Record<string, unknown>;

  for (const field of ['situation_summary', 'historical_comparison', 'statistical_context', 'assessment'] as const) {
    if (typeof v[field] !== 'string' || v[field].trim() === '') {
      throw new Error(`AI response field "${field}" must be a non-empty string`);
    }
  }

  if (!Array.isArray(v.similar_past_events)) {
    throw new Error('AI response field "similar_past_events" must be an array');
  }
  for (const [i, event] of v.similar_past_events.entries()) {
    if (typeof event !== 'object' || event === null) {
      throw new Error(`AI response similar_past_events[${i}] must be an object`);
    }
    const e = event as Record<string, unknown>;
    if (typeof e.alert_id !== 'string' || typeof e.triggered_at !== 'string' || typeof e.brief_outcome !== 'string') {
      throw new Error(`AI response similar_past_events[${i}] must have alert_id, triggered_at, brief_outcome as strings`);
    }
  }

  for (const [field, allowed] of [
    ['market_risk', RISK_LEVELS],
    ['exposure_risk', RISK_LEVELS],
    ['event_risk', RISK_LEVELS],
  ] as const) {
    if (!allowed.includes(v[field] as RiskLevel)) {
      throw new Error(`AI response field "${field}" must be one of ${allowed.join(', ')}, got ${JSON.stringify(v[field])}`);
    }
  }

  if (!NEWS_SENTIMENT_LEVELS.includes(v.news_sentiment as NewsSentimentLevel)) {
    throw new Error(`AI response field "news_sentiment" must be one of ${NEWS_SENTIMENT_LEVELS.join(', ')}, got ${JSON.stringify(v.news_sentiment)}`);
  }

  if (!RECOMMENDED_ACTIONS.includes(v.recommended_action as RecommendedAction)) {
    throw new Error(`AI response field "recommended_action" must be one of ${RECOMMENDED_ACTIONS.join(', ')}, got ${JSON.stringify(v.recommended_action)}`);
  }

  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
    throw new Error(`AI response field "confidence" must be a number between 0 and 1, got ${JSON.stringify(v.confidence)}`);
  }

  // Structurally absent, not just unchecked — a provider that adds a field
  // outside this exact shape (e.g. a free-text "action" alongside the
  // closed `recommended_action` enum) gets it silently dropped by this
  // return, never forwarded.
  return {
    situation_summary: v.situation_summary as string,
    historical_comparison: v.historical_comparison as string,
    statistical_context: v.statistical_context as string,
    similar_past_events: (v.similar_past_events as Array<Record<string, unknown>>).map((e) => ({
      alert_id: e.alert_id as string,
      triggered_at: e.triggered_at as string,
      brief_outcome: e.brief_outcome as string,
    })),
    market_risk: v.market_risk as RiskLevel,
    exposure_risk: v.exposure_risk as RiskLevel,
    event_risk: v.event_risk as RiskLevel,
    news_sentiment: v.news_sentiment as NewsSentimentLevel,
    confidence: v.confidence,
    assessment: v.assessment as string,
    recommended_action: v.recommended_action as RecommendedAction,
  };
}
