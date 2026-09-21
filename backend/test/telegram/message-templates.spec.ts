import { describe, expect, it } from 'vitest';
import { AiAnalysisResult } from '../../src/ai/ai-provider.interface';
import {
  renderAiNarrativeMessage,
  renderHeartbeatDigestMessage,
  renderMessage,
  renderSystemHealthMessage,
  renderTradingAlertMessage,
} from '../../src/telegram/message-templates';

describe('message-templates', () => {
  it('renders a trading alert from the frozen ruleSnapshot/triggerValues — no live lookups', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'drawdown guard', ruleType: 'DRAWDOWN', parameters: { threshold_pct: 0.03 } },
      triggerValues: { drawdown: 0.038 },
      triggeredAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(text).toContain('drawdown guard');
    expect(text).toContain('DRAWDOWN');
    expect(text).toContain('2026-01-01T00:00:00.000Z');
    expect(text).toContain('drawdown: 0.038');
    expect(text).toContain('threshold_pct: 0.03'); // the configured threshold, for a human to compare against
  });

  it('includes the account identity when the caller has fetched it', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'drawdown guard', ruleType: 'DRAWDOWN', parameters: {} },
      triggerValues: {},
      triggeredAt: new Date('2026-01-01T00:00:00Z'),
      account: { displayName: 'MT5 10012425443', externalAccountId: '10012425443' },
    });
    expect(text).toContain('Account: MT5 10012425443');
  });

  it('omits the account line entirely when the caller has not fetched it', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'DRAWDOWN', parameters: {} },
      triggerValues: {},
      triggeredAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(text).not.toContain('Account:');
  });

  it('falls back gracefully for a missing/malformed ruleSnapshot rather than throwing', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: null,
      triggerValues: {},
      triggeredAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(text).toContain('Unknown rule');
    expect(text).toContain('UNKNOWN');
  });

  it('renderMessage dispatches TRADING_ALERT to the trading template', () => {
    const text = renderMessage('TRADING_ALERT', {
      ruleSnapshot: { name: 'x', ruleType: 'DRAWDOWN' },
      triggerValues: {},
      triggeredAt: new Date(),
    });
    expect(text).toContain('Trading Alert');
  });

  it('SYSTEM_HEALTH has no source yet in Phase 5 and throws rather than sending a blank message', () => {
    expect(() => renderSystemHealthMessage({})).toThrow(/not implemented/i);
    expect(() => renderMessage('SYSTEM_HEALTH', { ruleSnapshot: {}, triggerValues: {}, triggeredAt: new Date() })).toThrow();
  });
});

describe('renderAiNarrativeMessage — Telegram cleanup pass (short, informational only)', () => {
  const RESULT: AiAnalysisResult = {
    situation_summary: 'Equity is down 3.8% from its all-time peak.',
    historical_comparison: "Larger than the account's typical daily swing.",
    similar_past_events: [{ alert_id: 'a0', triggered_at: '2026-01-01T00:00:00Z', brief_outcome: 'resolved after ~40 minutes' }],
    statistical_context: 'Drawdown: 3.8% vs a 3% threshold.',
    market_risk: 'MEDIUM',
    exposure_risk: 'HIGH',
    event_risk: 'HIGH',
    news_sentiment: 'NEGATIVE',
    confidence: 0.72,
    assessment: 'Price is approaching H1 resistance after a recent bullish structure shift.',
    recommended_action: 'REDUCE_RISK',
  };

  it('shows only the rule, the AI assessment sentence, and the posture — none of the other AiAnalysisResult fields', () => {
    const text = renderAiNarrativeMessage(RESULT, {
      ruleSnapshot: { name: 'drawdown guard' },
      triggerValues: {},
      triggeredAt: new Date(),
    });

    expect(text).toContain(RESULT.assessment);
    expect(text).toContain('Posture: REDUCE_RISK');
    expect(text).not.toContain(RESULT.situation_summary);
    expect(text).not.toContain(RESULT.historical_comparison);
    expect(text).not.toContain(RESULT.statistical_context);
    expect(text).not.toContain('Market risk');
    expect(text).not.toContain('Exposure risk');
    expect(text).not.toContain('Confidence');
    expect(text.toLowerCase()).not.toMatch(/\bbuy\b|\bsell\b/);
  });

  it('includes the timeframe in the header when triggerValues has one (the user\'s 3 custom rules)', () => {
    const text = renderAiNarrativeMessage(RESULT, {
      ruleSnapshot: { name: 'EURUSD Support/Resistance Proximity' },
      triggerValues: { timeframe: 'H1' },
      triggeredAt: new Date(),
    });
    expect(text).toContain('[EURUSD Support/Resistance Proximity] [H1]');
  });

  it('takes the timeframe from the first Ichimoku breakout when triggerValues has no plain timeframe field', () => {
    const text = renderAiNarrativeMessage(RESULT, {
      ruleSnapshot: { name: 'EURUSD Ichimoku Breakout' },
      triggerValues: { breakouts: [{ timeframe: 'H4' }] },
      triggeredAt: new Date(),
    });
    expect(text).toContain('[EURUSD Ichimoku Breakout] [H4]');
  });

  it('omits the timeframe bracket entirely for a rule type with no single-timeframe concept', () => {
    const text = renderAiNarrativeMessage(RESULT, {
      ruleSnapshot: { name: 'drawdown guard' },
      triggerValues: { drawdown: 0.038 },
      triggeredAt: new Date(),
    });
    expect(text).toContain('[drawdown guard]');
    expect(text).not.toMatch(/\[drawdown guard\]\s*\[/);
  });

  it('includes the account identity when the caller has fetched it', () => {
    const text = renderAiNarrativeMessage(RESULT, {
      ruleSnapshot: { name: 'x' },
      triggerValues: {},
      triggeredAt: new Date(),
      account: { displayName: 'MT5 10012425443', externalAccountId: '10012425443' },
    });
    expect(text).toContain('Account: MT5 10012425443');
  });
});

describe('renderHeartbeatDigestMessage', () => {
  it('reports all-OK plainly when every component is healthy', () => {
    const text = renderHeartbeatDigestMessage({
      generatedAt: new Date('2026-09-07T18:00:00Z'),
      healthByComponent: [
        { component: 'COLLECTOR', status: 'OK' },
        { component: 'TELEGRAM', status: 'OK' },
      ],
      totalAlertsToday: 0,
      alertsByRuleName: [],
    });
    expect(text).toContain('All systems OK');
    expect(text).toContain('Alerts today: 0');
    expect(text).not.toContain('need attention');
  });

  it('leads with a warning listing exactly the unhealthy components', () => {
    const text = renderHeartbeatDigestMessage({
      generatedAt: new Date('2026-09-07T18:00:00Z'),
      healthByComponent: [
        { component: 'COLLECTOR', status: 'OK' },
        { component: 'AI_PROVIDER', status: 'DOWN' },
        { component: 'TELEGRAM', status: 'DEGRADED' },
      ],
      totalAlertsToday: 1,
      alertsByRuleName: [{ ruleName: 'EURUSD Ichimoku Breakout', count: 1 }],
    });
    expect(text).toContain('2 component(s) need attention');
    expect(text).toContain('AI_PROVIDER: DOWN');
    expect(text).toContain('TELEGRAM: DEGRADED');
    expect(text).not.toContain('All systems OK');
  });

  it('breaks the alert count down by rule name', () => {
    const text = renderHeartbeatDigestMessage({
      generatedAt: new Date('2026-09-07T18:00:00Z'),
      healthByComponent: [{ component: 'COLLECTOR', status: 'OK' }],
      totalAlertsToday: 3,
      alertsByRuleName: [
        { ruleName: 'EURUSD Support/Resistance Proximity', count: 2 },
        { ruleName: 'EURUSD Daily Market Analysis', count: 1 },
      ],
    });
    expect(text).toContain('Alerts today: 3');
    expect(text).toContain('EURUSD Support/Resistance Proximity: 2');
    expect(text).toContain('EURUSD Daily Market Analysis: 1');
  });
});

describe('renderTradingAlertMessage — SUPPORT_RESISTANCE_PROXIMITY (Telegram cleanup pass)', () => {
  function srValues(overrides: Record<string, unknown> = {}) {
    return {
      symbol: 'EURUSD',
      currentPrice: 1.162271234567,
      timeframe: 'H1',
      levelType: 'RESISTANCE',
      levelPrice: 1.16240000001,
      distancePoints: 13.49999999999962,
      direction: 'BELOW',
      trend: 'APPROACHING',
      allMatches: [{ timeframe: 'H1', levelType: 'RESISTANCE', levelPrice: 1.1624 }],
      ...overrides,
    };
  }

  it('renders a clean, human-readable message — rule, timeframe, level, price, distance', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'EURUSD Support/Resistance Proximity', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {} },
      triggerValues: srValues(),
      triggeredAt: new Date(),
    });

    expect(text).toContain('[EURUSD Support/Resistance Proximity] [H1]');
    expect(text).toContain('APPROACHING RESISTANCE');
    expect(text).toContain('1.16240');
    expect(text).toContain('Current price: 1.16227');
    expect(text).toContain('Distance: 13.5 points');
  });

  it('never dumps allMatches (or any raw JSON/object) into the message', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {} },
      triggerValues: srValues(),
      triggeredAt: new Date(),
    });
    expect(text).not.toContain('allMatches');
    expect(text).not.toContain('{');
    expect(text).not.toContain('[object');
  });

  it('never mentions BUY, SELL, entry, stop loss, or take profit', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {} },
      triggerValues: srValues(),
      triggeredAt: new Date(),
    });
    expect(text.toLowerCase()).not.toMatch(/\bbuy\b|\bsell\b|entry|stop loss|take profit/);
  });

  it('rounds prices and distance instead of showing raw floating-point noise', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {} },
      triggerValues: srValues(),
      triggeredAt: new Date(),
    });
    expect(text).not.toContain('13.49999999999962');
    expect(text).not.toContain('1.16240000001');
  });

  it('describes RETREATING and an UNKNOWN trend in plain words rather than the raw enum alone', () => {
    const retreating = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {} },
      triggerValues: srValues({ trend: 'RETREATING' }),
      triggeredAt: new Date(),
    });
    expect(retreating).toContain('RETREATING');

    const unknown = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {} },
      triggerValues: srValues({ trend: 'UNKNOWN' }),
      triggeredAt: new Date(),
    });
    expect(unknown).toContain('near RESISTANCE');
  });
});

describe('renderTradingAlertMessage — ICHIMOKU_BREAKOUT (Telegram cleanup pass, informational only)', () => {
  it('renders which timeframe and which side of the cloud, nothing else', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'EURUSD Ichimoku Breakout', ruleType: 'ICHIMOKU_BREAKOUT', parameters: {} },
      triggerValues: {
        symbol: 'EURUSD',
        breakouts: [{ timeframe: 'H1', direction: 'BULLISH', previousState: 'INSIDE_CLOUD', newState: 'ABOVE_CLOUD', breakoutPrice: 1.16123, timestamp: '2026-09-07T10:00:00Z' }],
      },
      triggeredAt: new Date(),
    });

    expect(text).toContain('[EURUSD Ichimoku Breakout] [H1]');
    expect(text).toContain('broke ABOVE the Ichimoku Cloud');
    expect(text).toContain('Current price: 1.16123');
  });

  it('never generates a BUY/SELL recommendation regardless of breakout direction — this rule is alerts only', () => {
    const above = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'ICHIMOKU_BREAKOUT', parameters: {} },
      triggerValues: { breakouts: [{ timeframe: 'H1', newState: 'ABOVE_CLOUD', breakoutPrice: 1.161 }] },
      triggeredAt: new Date(),
    });
    const below = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'ICHIMOKU_BREAKOUT', parameters: {} },
      triggerValues: { breakouts: [{ timeframe: 'H1', newState: 'BELOW_CLOUD', breakoutPrice: 1.161 }] },
      triggeredAt: new Date(),
    });
    for (const text of [above, below]) {
      expect(text.toLowerCase()).not.toMatch(/\bbuy\b|\bsell\b|entry|stop loss|take profit/);
    }
  });

  it('renders one block per breakout when more than one timeframe breaks simultaneously', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'EURUSD Ichimoku Breakout', ruleType: 'ICHIMOKU_BREAKOUT', parameters: {} },
      triggerValues: {
        breakouts: [
          { timeframe: 'H1', newState: 'ABOVE_CLOUD', breakoutPrice: 1.161 },
          { timeframe: 'H4', newState: 'BELOW_CLOUD', breakoutPrice: 1.162 },
        ],
      },
      triggeredAt: new Date(),
    });
    expect(text).toContain('[H1]');
    expect(text).toContain('broke ABOVE the Ichimoku Cloud');
    expect(text).toContain('[H4]');
    expect(text).toContain('broke BELOW the Ichimoku Cloud');
  });
});

describe('renderTradingAlertMessage — DAILY_MARKET_ANALYSIS (Telegram cleanup pass)', () => {
  function dailyValues(overrides: Record<string, unknown> = {}) {
    return {
      symbol: 'EURUSD',
      currentPrice: 1.105,
      marketBias: 'BULLISH',
      biasConfidence: 0.667,
      biasReasons: ['H4 Ichimoku trend condition is bullish (price above the cloud)'],
      fibonacci: {
        swingHigh: 1.15,
        swingLow: 1.05,
        direction: 'BULLISH',
        levels: [{ ratio: 0.618, price: 1.0882 }],
        nearestLevelRatio: 0.618,
        nearestLevelPrice: 1.0882,
      },
      supportResistance: [{ timeframe: 'H4', levelType: 'RESISTANCE', price: 1.12 }],
      ichimoku: [{ timeframe: 'H4', position: 'ABOVE_CLOUD', spanA: 1.09, spanB: 1.08 }],
      upcomingEconomicEvents: [{ title: 'FOMC Interest Rate Decision', scheduledAt: '2026-09-16T18:00:00.000Z', affectedCurrencies: ['USD'] }],
      recentNews: [{ title: 'ECB signals steady rates', scheduledAt: '2026-09-06T09:00:00.000Z', sentiment: 'NEUTRAL' }],
      timestamp: '2026-09-07T05:00:00.000Z',
      ...overrides,
    };
  }

  it('renders only the rule, timeframe, daily bias, and nearest Fibonacci level', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'EURUSD Daily Market Analysis', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {} },
      triggerValues: dailyValues(),
      triggeredAt: new Date('2026-09-07T05:00:00Z'),
    });

    expect(text).toContain('[EURUSD Daily Market Analysis] [D1]');
    expect(text).toContain('Daily Bias: BULLISH');
    expect(text).toContain('Fibonacci Level: 61.8% at 1.08820');
  });

  it('drops the per-timeframe S/R list, Ichimoku list, and economic events/news — the "fluff" this pass removes', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {} },
      triggerValues: dailyValues(),
      triggeredAt: new Date(),
    });

    expect(text).not.toContain('Support and Resistance');
    expect(text).not.toContain('Ichimoku');
    expect(text).not.toContain('FOMC Interest Rate Decision');
    expect(text).not.toContain('ECB signals steady rates');
  });

  it('omits the Fibonacci line entirely for a null Fibonacci analysis rather than crashing', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {} },
      triggerValues: dailyValues({ fibonacci: null }),
      triggeredAt: new Date(),
    });
    expect(text).toContain('Daily Bias: BULLISH');
    expect(text).not.toContain('Fibonacci Level');
  });

  it('never mentions BUY, SELL, entry, stop loss, or take profit', () => {
    const text = renderTradingAlertMessage({
      ruleSnapshot: { name: 'x', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {} },
      triggerValues: dailyValues(),
      triggeredAt: new Date(),
    });
    expect(text.toLowerCase()).not.toMatch(/\bbuy\b|\bsell\b|entry|stop loss|take profit/);
  });
});
