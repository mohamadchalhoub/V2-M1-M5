import { NotificationClass } from '@prisma/client';
import { AiAnalysisResult } from '../ai/ai-provider.interface';

export interface AlertMessageInput {
  ruleSnapshot: unknown;
  triggerValues: unknown;
  triggeredAt: Date;
  /** Optional — not every caller has fetched it (e.g. the AI-narrative path
   * doesn't need it). When present, rendered as the message's first line so
   * a trader with multiple monitored accounts always knows which one fired. */
  account?: { displayName: string | null; externalAccountId: string } | null;
}

/**
 * Pure rendering — built entirely from the Alert's already-frozen
 * trigger_values/rule_snapshot (Phase 4's immutability guarantee), never a
 * fresh AnalyticsService/RuleEngineService call.
 */
export function renderTradingAlertMessage(alert: AlertMessageInput): string {
  const rule = (alert.ruleSnapshot ?? {}) as Record<string, unknown>;
  const ruleName = typeof rule.name === 'string' ? rule.name : 'Unknown rule';
  const ruleType = typeof rule.ruleType === 'string' ? rule.ruleType : 'UNKNOWN';
  const parameters = (rule.parameters ?? {}) as Record<string, unknown>;
  const values = (alert.triggerValues ?? {}) as Record<string, unknown>;

  // Telegram cleanup pass — dedicated, human-readable renderers for the
  // user's 3 custom EURUSD rules, instead of the generic flat key-value
  // dump below (which would otherwise JSON.stringify nested arrays like
  // `allMatches`/`breakouts` into an unreadable raw dump — the exact
  // complaint this pass fixes). Dispatched by ruleType alone, still through
  // the exact same TRADING_ALERT AlertDelivery/Telegram pipeline as every
  // other rule — no changes to AlertLifecycleService or NotificationClass.
  // Strictly informational, same as every other rendering in this file:
  // these show price/level/timeframe facts only, never a BUY/SELL,
  // entry, stop loss, or take profit (the user's own explicit boundary —
  // "my job will be only informative, and me the one who made all orders").
  if (ruleType === 'SUPPORT_RESISTANCE_PROXIMITY') {
    return renderSupportResistanceMessage(values, alert, ruleName);
  }
  if (ruleType === 'ICHIMOKU_BREAKOUT') {
    return renderIchimokuBreakoutMessage(values, alert, ruleName);
  }
  if (ruleType === 'DAILY_MARKET_ANALYSIS') {
    return renderDailyMarketAnalysisMessage(values, alert, ruleName);
  }

  const lines = [`⚠️ Trading Alert: ${ruleName}`];
  if (alert.account) {
    lines.push(`Account: ${alert.account.displayName ?? alert.account.externalAccountId}`);
  }
  lines.push(`Type: ${ruleType}`, `Triggered: ${alert.triggeredAt.toISOString()}`, '', 'Trigger values:');
  lines.push(...Object.entries(values).map(([key, value]) => `  ${key}: ${formatValue(value)}`));

  const paramEntries = Object.entries(parameters);
  if (paramEntries.length > 0) {
    lines.push('', 'Configured threshold:');
    lines.push(...paramEntries.map(([key, value]) => `  ${key}: ${formatValue(value)}`));
  }

  return lines.join('\n');
}

/**
 * User's Rule 1 (Support/Resistance Proximity) — Telegram cleanup pass.
 * Shows exactly what the user asked for: rule, timeframe, which level and
 * direction, current price, distance — nothing else. `allMatches` (every
 * simultaneous match across timeframes, needed for the AI's fuller context)
 * is deliberately NOT rendered here — it's still in `triggerValues`/sent to
 * the AI, just not dumped into this human-facing message.
 */
function renderSupportResistanceMessage(values: Record<string, unknown>, alert: AlertMessageInput, ruleName: string): string {
  const symbol = String(values.symbol ?? 'EURUSD');
  const timeframe = String(values.timeframe ?? '');
  const levelType = String(values.levelType ?? '');
  const trendWord = describeTrend(values.trend);

  const lines = [`📊 [${ruleName}] [${timeframe}]`];
  if (alert.account) {
    lines.push(`Account: ${alert.account.displayName ?? alert.account.externalAccountId}`);
  }
  lines.push(
    `📍 ${symbol} ${trendWord} ${levelType} at ${formatPrice(values.levelPrice)}`,
    // "Current price" is a snapshot of the moment this alert fired — never a
    // live-updating figure. Without an explicit capture time in the message
    // body itself, a reader checking Telegram minutes later has no way to
    // tell this from a live quote, and a since-moved real price reads as
    // "the bot sent wrong numbers" (a real support ticket this caused).
    // Telegram's own per-message timestamp is technically enough, but it's
    // small, easy to not register, and easy to not mentally subtract from
    // "now" — spelling it out here removes the ambiguity entirely.
    `💰 Current price: ${formatPrice(values.currentPrice)} (🕒 as of ${formatBeirutTime(alert.triggeredAt)})`,
    `📏 Distance: ${formatDistance(values.distancePoints)} points`,
  );
  return lines.join('\n');
}

/** Beirut wall-clock time, matching the dashboard's own display convention (frontend/src/lib/format.ts) — this is a monitoring tool for one Beirut-based trader, not a multi-timezone product. */
function formatBeirutTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeStyle: 'medium', timeZone: 'Asia/Beirut' }).format(date);
}

function describeTrend(trend: unknown): string {
  switch (trend) {
    case 'APPROACHING':
      return 'APPROACHING';
    case 'RETREATING':
      return 'RETREATING (moving away from)';
    case 'FLAT':
      return 'holding steady near';
    default:
      return 'near';
  }
}

/**
 * User's Rule 2 (Ichimoku Breakout) — Telegram cleanup pass. Strictly
 * informational per the user's explicit instruction: states which
 * timeframe broke and which side of the cloud, nothing else — no
 * BUY/SELL, no entry/SL/TP, ever, regardless of breakout direction.
 * `extra.ichimokuBreakouts` can carry more than one simultaneous breakout
 * (multi-timeframe confluence) — each gets its own block.
 */
function renderIchimokuBreakoutMessage(values: Record<string, unknown>, alert: AlertMessageInput, ruleName: string): string {
  const breakouts = asArray(values.breakouts) as Record<string, unknown>[];
  const blocks = breakouts.map((breakout) => {
    const timeframe = String(breakout.timeframe ?? '');
    const lines = [`📊 [${ruleName}] [${timeframe}]`];
    if (alert.account) {
      lines.push(`Account: ${alert.account.displayName ?? alert.account.externalAccountId}`);
    }
    lines.push(
      `☁️ Price broke ${cloudSideLabel(breakout.newState)} the Ichimoku Cloud`,
      `💰 Current price: ${formatPrice(breakout.breakoutPrice)} (🕒 as of ${formatBeirutTime(alert.triggeredAt)})`,
    );
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

function cloudSideLabel(newState: unknown): string {
  if (newState === 'ABOVE_CLOUD') return 'ABOVE';
  if (newState === 'BELOW_CLOUD') return 'BELOW';
  return String(newState ?? 'UNKNOWN');
}

/**
 * User's Rules 3+4 (daily morning report) — Telegram cleanup pass. Shows
 * only the daily bias and the nearest Fibonacci level; the fuller detail
 * (per-timeframe S/R, Ichimoku state, economic events/news) is still
 * computed and still sent to the AI as context — just no longer dumped
 * into this human-facing message ("economic fluff," the user's own words).
 */
function renderDailyMarketAnalysisMessage(values: Record<string, unknown>, alert: AlertMessageInput, ruleName: string): string {
  const lines = [`📊 [${ruleName}] [D1]`];
  if (alert.account) {
    lines.push(`Account: ${alert.account.displayName ?? alert.account.externalAccountId}`);
  }
  lines.push(`📈 Daily Bias: ${values.marketBias ?? 'NEUTRAL'} (🕒 as of ${formatBeirutTime(alert.triggeredAt)})`);

  const fibonacci = values.fibonacci as Record<string, unknown> | null;
  if (fibonacci) {
    lines.push(`📍 Fibonacci Level: ${formatFibRatio(fibonacci.nearestLevelRatio)} at ${formatPrice(fibonacci.nearestLevelPrice)}`);
  }

  return lines.join('\n');
}

function formatFibRatio(ratio: unknown): string {
  return typeof ratio === 'number' ? `${(ratio * 100).toFixed(1)}%` : 'n/a';
}

/** EURUSD prices to the same 5-digit precision this deployment quotes at — never raw floating-point noise (e.g. "13.49999999999962"). */
function formatPrice(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(5) : 'n/a';
}

/** Distance in points, rounded to 1 decimal — same "no raw floating-point noise" reasoning as formatPrice. */
function formatDistance(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(1) : 'n/a';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Phase 6 — message #2 (AI_INTEGRATION_SPEC.md §1): a follow-up narrative,
 * sent only when an `AiAnalysis` reaches `READY` (schema-valid AND passed
 * the safety filter, ai/safety-filter.ts — never reached for a WITHHELD
 * result). Purely a rendering of already-generated, already-filtered text;
 * this function makes no decision of its own.
 *
 * Telegram cleanup pass — cut down from a multi-section dump (situation
 * summary, historical comparison, similar past events, a 4-metric risk
 * table) to `assessment` (already constrained by ai-prompt.ts's system
 * prompt to one concise, factual sentence, never a trade instruction) plus
 * the risk-management posture. `AiAnalysisResult`'s full schema is
 * unchanged — every other field is still generated, validated, and stored
 * for audit; only what's rendered into this human-facing message shrank.
 */
export function renderAiNarrativeMessage(result: AiAnalysisResult, alert: AlertMessageInput): string {
  const rule = (alert.ruleSnapshot ?? {}) as Record<string, unknown>;
  const ruleName = typeof rule.name === 'string' ? rule.name : 'Unknown rule';
  const timeframe = extractTimeframeLabel(alert.triggerValues);

  const lines = [`📊 [${ruleName}]${timeframe ? ` [${timeframe}]` : ''}`];
  if (alert.account) {
    lines.push(`Account: ${alert.account.displayName ?? alert.account.externalAccountId}`);
  }
  lines.push(`🧠 AI: ${result.assessment}`, `Posture: ${result.recommended_action}`);
  return lines.join('\n');
}

/** Best-effort single timeframe label for the AI-narrative header — present for the user's 3 custom rules (a plain `timeframe` field, or the first Ichimoku breakout's), absent for rule types with no single-timeframe concept (e.g. DRAWDOWN). */
function extractTimeframeLabel(triggerValues: unknown): string | null {
  const values = (triggerValues ?? {}) as Record<string, unknown>;
  if (typeof values.timeframe === 'string') return values.timeframe;
  const breakouts = asArray(values.breakouts) as Record<string, unknown>[];
  if (breakouts.length > 0 && typeof breakouts[0]?.timeframe === 'string') return breakouts[0].timeframe as string;
  return null;
}

/**
 * Scaffolding for Phase 0 §13's health module — no `health_incidents` source
 * exists yet, so no `AlertDelivery` in Phase 5 is ever created with this
 * class (RuleEngineService/AlertLifecycleService only ever write
 * TRADING_ALERT). Throws rather than silently rendering nothing, so a
 * future wiring mistake fails loudly instead of sending a blank message.
 */
export function renderSystemHealthMessage(_incident: unknown): string {
  throw new Error('SYSTEM_HEALTH message rendering is not implemented — no health module exists yet');
}

export function renderMessage(notificationClass: NotificationClass, alert: AlertMessageInput): string {
  switch (notificationClass) {
    case 'TRADING_ALERT':
      return renderTradingAlertMessage(alert);
    case 'SYSTEM_HEALTH':
      return renderSystemHealthMessage(alert);
    default: {
      const exhaustive: never = notificationClass;
      throw new Error(`No message template for notification class ${exhaustive as string}`);
    }
  }
}

export interface HeartbeatDigestInput {
  generatedAt: Date;
  healthByComponent: { component: string; status: string }[];
  totalAlertsToday: number;
  alertsByRuleName: { ruleName: string; count: number }[];
}

/**
 * Reliability pass — "let me know the system is alive even on a quiet day"
 * (a daily digest, not an incident notification). Deliberately NOT part of
 * `renderMessage`/`NotificationClass` — that dispatch is for the
 * Alert/AlertDelivery pipeline, and this digest is sent directly by
 * `health/heartbeat-digest.processor.ts` to TELEGRAM_OPS_CHAT_IDS, once a
 * day, independent of any single Alert. Pure rendering only, same as every
 * other function in this file.
 */
export function renderHeartbeatDigestMessage(input: HeartbeatDigestInput): string {
  const unhealthy = input.healthByComponent.filter((c) => c.status !== 'OK');
  const lines = ['🫀 Daily System Heartbeat', `Generated: ${input.generatedAt.toISOString()}`];

  if (unhealthy.length > 0) {
    lines.push('', `⚠️ ${unhealthy.length} component(s) need attention:`);
    lines.push(...unhealthy.map((c) => `  ${c.component}: ${c.status}`));
  } else {
    lines.push('', '✅ All systems OK.');
  }

  lines.push('', 'System health:');
  lines.push(...input.healthByComponent.map((c) => `  ${c.component}: ${c.status}`));

  lines.push('', `Alerts today: ${input.totalAlertsToday}`);
  for (const { ruleName, count } of input.alertsByRuleName) {
    lines.push(`  ${ruleName}: ${count}`);
  }

  return lines.join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
