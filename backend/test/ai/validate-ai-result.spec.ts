import { describe, expect, it } from 'vitest';
import { validateAiAnalysisResult } from '../../src/ai/validate-ai-result';

const VALID = {
  situation_summary: 'summary',
  historical_comparison: 'comparison',
  similar_past_events: [{ alert_id: 'a1', triggered_at: '2026-01-01T00:00:00Z', brief_outcome: 'resolved' }],
  statistical_context: 'context',
  market_risk: 'LOW',
  exposure_risk: 'MEDIUM',
  event_risk: 'LOW',
  news_sentiment: 'NEUTRAL',
  confidence: 0.7,
  assessment: 'risk assessment narrative',
  recommended_action: 'MONITOR',
};

describe('validateAiAnalysisResult', () => {
  it('accepts a well-formed response', () => {
    expect(() => validateAiAnalysisResult(VALID)).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateAiAnalysisResult('not an object')).toThrow();
    expect(() => validateAiAnalysisResult(null)).toThrow();
    expect(() => validateAiAnalysisResult(undefined)).toThrow();
  });

  it('rejects a missing required string field', () => {
    const { situation_summary, ...rest } = VALID;
    expect(() => validateAiAnalysisResult(rest)).toThrow(/situation_summary/);
  });

  it('rejects an empty-string required field', () => {
    expect(() => validateAiAnalysisResult({ ...VALID, statistical_context: '' })).toThrow(/statistical_context/);
  });

  it('rejects similar_past_events that is not an array', () => {
    expect(() => validateAiAnalysisResult({ ...VALID, similar_past_events: 'nope' })).toThrow(/similar_past_events/);
  });

  it('rejects a malformed similar_past_events entry', () => {
    expect(() =>
      validateAiAnalysisResult({ ...VALID, similar_past_events: [{ alert_id: 'a1' }] }),
    ).toThrow(/similar_past_events\[0\]/);
  });

  it('structurally strips any extra field a provider adds — a free-text "action" field never survives validation', () => {
    const withExtra = { ...VALID, action: 'increase position', suggested_trade: 'buy EURUSD' };
    const result = validateAiAnalysisResult(withExtra);
    expect(result).not.toHaveProperty('action');
    expect(result).not.toHaveProperty('suggested_trade');
    expect(Object.keys(result).sort()).toEqual(
      [
        'assessment',
        'event_risk',
        'exposure_risk',
        'historical_comparison',
        'market_risk',
        'news_sentiment',
        'confidence',
        'recommended_action',
        'similar_past_events',
        'situation_summary',
        'statistical_context',
      ].sort(),
    );
  });

  it('rejects a market_risk/exposure_risk/event_risk value outside the closed LOW/MEDIUM/HIGH/CRITICAL set', () => {
    expect(() => validateAiAnalysisResult({ ...VALID, market_risk: 'EXTREME' })).toThrow(/market_risk/);
    expect(() => validateAiAnalysisResult({ ...VALID, exposure_risk: 'buy' })).toThrow(/exposure_risk/);
  });

  it('rejects a news_sentiment value outside the closed set', () => {
    expect(() => validateAiAnalysisResult({ ...VALID, news_sentiment: 'BULLISH' })).toThrow(/news_sentiment/);
  });

  it('rejects a recommended_action outside the closed four-value set — never a trade direction like "BUY"', () => {
    expect(() => validateAiAnalysisResult({ ...VALID, recommended_action: 'BUY' })).toThrow(/recommended_action/);
    expect(() => validateAiAnalysisResult({ ...VALID, recommended_action: 'SELL_NOW' })).toThrow(/recommended_action/);
  });

  it('rejects a confidence outside 0-1', () => {
    expect(() => validateAiAnalysisResult({ ...VALID, confidence: 1.5 })).toThrow(/confidence/);
    expect(() => validateAiAnalysisResult({ ...VALID, confidence: -0.1 })).toThrow(/confidence/);
    expect(() => validateAiAnalysisResult({ ...VALID, confidence: 'high' })).toThrow(/confidence/);
  });

  it('rejects a missing/empty assessment', () => {
    expect(() => validateAiAnalysisResult({ ...VALID, assessment: '' })).toThrow(/assessment/);
  });
});
