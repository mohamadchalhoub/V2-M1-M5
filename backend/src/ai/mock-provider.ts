import { Injectable } from '@nestjs/common';
import { AiAnalysisResult, AiProvider, AlertContext } from './ai-provider.interface';

// A third AiProvider alongside Anthropic/OpenRouter (same DI seam,
// ai.module.ts's provider-selection switch) — for local dev and any future
// test that wants to exercise the real pipeline (queue → provider →
// validate-ai-result.ts → safety-filter.ts → Telegram narration job)
// without a real API key or network call. Existing tests keep mocking
// `fetch` directly (setup-telegram-mock.ts et al.) and are unaffected;
// this is an additional, opt-in path via AI_PROVIDER=mock.
@Injectable()
export class MockAiProvider implements AiProvider {
  async analyze(context: AlertContext): Promise<AiAnalysisResult> {
    return {
      situation_summary: `[MOCK] ${context.ruleName} triggered for rule type ${context.ruleType}.`,
      historical_comparison: '[MOCK] deterministic mock response — no real model call was made.',
      similar_past_events: context.similarPastEvents.map((e) => ({
        alert_id: e.alertId,
        triggered_at: e.triggeredAt.toISOString(),
        brief_outcome: e.briefOutcome,
      })),
      statistical_context: '[MOCK] statistical context placeholder.',
      market_risk: 'LOW',
      exposure_risk: 'LOW',
      event_risk: 'LOW',
      news_sentiment: 'NEUTRAL',
      confidence: 0,
      assessment: '[MOCK] this is a deterministic mock analysis for local development/testing, not a real AI response.',
      recommended_action: 'MONITOR',
    };
  }
}
