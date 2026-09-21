import { describe, expect, it } from 'vitest';
import { checkSafety } from '../../src/ai/safety-filter';
import { AiAnalysisResult } from '../../src/ai/ai-provider.interface';

function resultWith(overrides: Partial<AiAnalysisResult> = {}): AiAnalysisResult {
  return {
    situation_summary: 'Equity is down 3.8% from its all-time peak.',
    historical_comparison: 'This is larger than the account\'s typical daily swing.',
    similar_past_events: [],
    statistical_context: 'Drawdown: 3.8% vs a 3% threshold.',
    market_risk: 'LOW',
    exposure_risk: 'LOW',
    event_risk: 'LOW',
    news_sentiment: 'NEUTRAL',
    confidence: 0.6,
    assessment: 'Risk is currently contained; no upcoming high-impact events for this account\'s exposure.',
    recommended_action: 'MONITOR',
    ...overrides,
  };
}

describe('checkSafety', () => {
  it('does not flag a purely descriptive, safe result', () => {
    expect(checkSafety(resultWith()).flagged).toBe(false);
  });

  it('flags "you should" anywhere in a free-text field', () => {
    const result = checkSafety(resultWith({ situation_summary: 'You should reduce risk here.' }));
    expect(result.flagged).toBe(true);
    expect(result.pattern).toBeTruthy();
  });

  it('flags "consider closing/opening/buying/selling"', () => {
    expect(checkSafety(resultWith({ historical_comparison: 'Consider closing this position.' })).flagged).toBe(true);
    expect(checkSafety(resultWith({ historical_comparison: 'Consider buying more here.' })).flagged).toBe(true);
  });

  it('flags "buy now" / "sell now"', () => {
    expect(checkSafety(resultWith({ statistical_context: 'Sell now before it worsens.' })).flagged).toBe(true);
  });

  it('flags a recommendation-shaped phrase even inside descriptive prose', () => {
    const result = checkSafety(
      resultWith({ statistical_context: 'Based on the numbers, our recommendation is to act quickly.' }),
    );
    expect(result.flagged).toBe(true);
  });

  it('flags matches inside similar_past_events.brief_outcome too, not just the top-level fields', () => {
    const result = checkSafety(
      resultWith({
        similar_past_events: [{ alert_id: 'a1', triggered_at: '2026-01-01T00:00:00Z', brief_outcome: 'You should have closed then.' }],
      }),
    );
    expect(result.flagged).toBe(true);
  });

  it('does not flag the unrelated word "considered" (only the imperative "consider closing/opening/..." construction matches)', () => {
    const result = checkSafety(resultWith({ situation_summary: 'This pattern is generally considered unusual for this account.' }));
    expect(result.flagged).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(checkSafety(resultWith({ situation_summary: 'YOU SHOULD close this.' })).flagged).toBe(true);
  });

  it('market intelligence phase 6: flags imperative language inside the new free-text "assessment" field too', () => {
    expect(checkSafety(resultWith({ assessment: 'You should reduce exposure before the CPI release.' })).flagged).toBe(true);
  });

  it('market intelligence phase 6: never flags a purely descriptive assessment or a closed-enum recommended_action value', () => {
    const result = checkSafety(
      resultWith({
        assessment: 'Exposure to USD is elevated ahead of a high-impact release.',
        recommended_action: 'REDUCE_RISK',
      }),
    );
    expect(result.flagged).toBe(false);
  });
});
