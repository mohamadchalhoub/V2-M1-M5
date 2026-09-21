/**
 * Telegram message templates (§13).
 *
 * One rule governs every message here: **it must be impossible to confuse a
 * message from this bot with one from the bot that is still running.**
 *
 * The two trade the same symbol, on the same broker, from the same machine,
 * and both send gold entry and exit notifications. An operator glancing at a
 * phone at 02:00 must be able to tell instantly which system acted. So every
 * trade-related message carries the strategy id, the account, and the
 * timeframe — not as a footer, but in the first line where it is read first.
 *
 * Two further rules, both about not overstating what is known:
 *
 * - A fill, a closure or a flat state is NEVER reported from a request
 *   acknowledgement. §13 is explicit, and the failure it prevents is a
 *   message saying "closed" about a position that is still open.
 * - An unlock message is informational. It says eligibility changed, and it
 *   says explicitly that no order was placed, because the natural reading of
 *   "SELL unlocked" is otherwise that something is about to happen.
 */
import { describeLockScope, describeUnlockCondition } from './locks';
import { SPEC, XAUUSD_M1M5_STRATEGY_VERSION, type Direction, type Timeframe } from './spec';

export interface MessageContext {
  /** The DEMO account this application trades, e.g. "DEMO 12345678". */
  readonly accountLabel: string;
}

/**
 * The identifying prefix every trade-related message starts with.
 *
 * Deliberately verbose. Brevity here would save a line and cost the one thing
 * the message exists to make unambiguous.
 */
function header(ctx: MessageContext, timeframe: Timeframe): string {
  return `[${XAUUSD_M1M5_STRATEGY_VERSION} | ${ctx.accountLabel} | ${timeframe}]`;
}

export function signalMessage(
  ctx: MessageContext,
  p: { timeframe: Timeframe; direction: Direction; rsi: number; previousRsi: number; price: number },
): string {
  const threshold = p.direction === 'SELL' ? SPEC.thresholds.sellCross : SPEC.thresholds.buyCross;
  return [
    `${header(ctx, p.timeframe)} ${p.direction} signal`,
    `RSI crossed ${threshold}: ${p.previousRsi} -> ${p.rsi}`,
    `${SPEC.symbol} at ${p.price}`,
  ].join('\n');
}

export function skippedMessage(
  ctx: MessageContext,
  p: { timeframe: Timeframe; direction: Direction; reason: string; detail: string },
): string {
  return [
    `${header(ctx, p.timeframe)} ${p.direction} signal SKIPPED — ${p.reason}`,
    p.detail,
    'The signal was consumed. It is not queued and will not be executed later.',
  ].join('\n');
}

export function submittedMessage(
  ctx: MessageContext,
  p: {
    timeframe: Timeframe;
    direction: Direction;
    volumeLots: number;
    requestedPrice: number;
    stopLoss: number;
    takeProfit: number;
  },
): string {
  return [
    `${header(ctx, p.timeframe)} ${p.direction} order SUBMITTED`,
    `${p.volumeLots} lots at ~${p.requestedPrice}, SL ${p.stopLoss}, TP ${p.takeProfit}`,
    // Stated explicitly so this is never mistaken for a fill.
    'Submitted, not filled. A confirmation will follow only when the broker confirms it.',
  ].join('\n');
}

export function filledMessage(
  ctx: MessageContext,
  p: {
    timeframe: Timeframe;
    direction: Direction;
    ticket: string;
    volumeLots: number;
    requestedPrice: number;
    fillPrice: number;
    brokerStopLoss: number | null;
    brokerTakeProfit: number | null;
  },
): string {
  const slippage = p.fillPrice - p.requestedPrice;
  const protection =
    p.brokerStopLoss === null || p.brokerTakeProfit === null
      ? 'WARNING: the broker did not report both protective levels. Protection remediation will run.'
      : `Broker-confirmed SL ${p.brokerStopLoss}, TP ${p.brokerTakeProfit}.`;
  return [
    `${header(ctx, p.timeframe)} ${p.direction} FILLED — ticket ${p.ticket}`,
    `${p.volumeLots} lots at ${p.fillPrice} (requested ${p.requestedPrice}, slippage ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)})`,
    protection,
  ].join('\n');
}

export function uncertainMessage(
  ctx: MessageContext,
  p: { timeframe: Timeframe; direction: Direction; detail: string },
): string {
  return [
    `${header(ctx, p.timeframe)} ${p.direction} submission UNCERTAIN`,
    p.detail,
    'This may or may not be a live position. The timeframe stays occupied and reconciliation continues until ' +
      'broker state resolves it. No second order will be sent.',
  ].join('\n');
}

export function rejectedMessage(
  ctx: MessageContext,
  p: { timeframe: Timeframe; direction: Direction; origin: 'TERMINAL' | 'BROKER'; detail: string },
): string {
  return [
    `${header(ctx, p.timeframe)} ${p.direction} order REJECTED (${p.origin}-side)`,
    p.detail,
    p.origin === 'TERMINAL'
      ? 'This originates in the terminal and can usually be corrected locally, on this application’s terminal only.'
      : 'This originates at the broker and cannot be corrected from the terminal.',
  ].join('\n');
}

export function closedMessage(
  ctx: MessageContext,
  p: {
    timeframe: Timeframe;
    direction: Direction;
    ticket: string;
    netRealized: number;
    closureReason: string;
    classification: 'WIN' | 'LOSS' | 'ZERO';
  },
): string {
  return [
    `${header(ctx, p.timeframe)} ${p.direction} CLOSED — ticket ${p.ticket}`,
    `${p.closureReason}. Broker-confirmed net realized ${p.netRealized >= 0 ? '+' : ''}${p.netRealized.toFixed(2)} (${p.classification}).`,
    'Net of commission, swap and fees, aggregated across every deal of this position.',
  ].join('\n');
}

/**
 * §13 — a loss-lock activation names the affected timeframe and direction,
 * the realized result and the unlock conditions, and states that the other
 * three are unaffected.
 */
export function lockActivatedMessage(
  ctx: MessageContext,
  p: { timeframe: Timeframe; direction: Direction; netRealized: number; ticket: string; closureReason: string },
): string {
  return [
    `${header(ctx, p.timeframe)} ${p.direction} LOCKED after a realized loss`,
    `Ticket ${p.ticket} closed ${p.closureReason} for ${p.netRealized.toFixed(2)}.`,
    `${p.timeframe} ${p.direction} entries are now blocked. ${describeUnlockCondition(p.direction)}`,
    describeLockScope(p.timeframe, p.direction),
  ].join('\n');
}

/**
 * §13 — an unlock message is informational and must not read as though a
 * trade is imminent.
 */
export function lockReleasedMessage(
  ctx: MessageContext,
  p: { timeframe: Timeframe; direction: Direction; rsi: number; condition: string; threshold: number },
): string {
  const entryThreshold = p.direction === 'SELL' ? SPEC.thresholds.sellCross : SPEC.thresholds.buyCross;
  const rearm =
    p.direction === 'SELL'
      ? `RSI must return below ${entryThreshold} and then cross up through it again.`
      : `RSI must return above ${entryThreshold} and then cross down through it again.`;
  return [
    `${header(ctx, p.timeframe)} ${p.direction} UNLOCKED`,
    `RSI ${p.rsi} satisfied ${p.condition} ${p.threshold}.`,
    // The critical sentence. Without it, "unlocked" reads as "trading".
    'This changes eligibility only. No order has been placed, and the crossing that was skipped while locked ' +
      'is not replayed.',
    `A fresh entry crossing is required: ${rearm}`,
  ].join('\n');
}

export function liquidationCompleteMessage(ctx: MessageContext, p: { closedCount: number }): string {
  return [
    `[${XAUUSD_M1M5_STRATEGY_VERSION} | ${ctx.accountLabel}] Friday liquidation COMPLETE`,
    `Broker-confirmed: no open positions and no pending orders belonging to this application (${p.closedCount} closed).`,
    'Positions belonging to any other application were not included and are unaffected.',
  ].join('\n');
}

export function liquidationFailedMessage(
  ctx: MessageContext,
  p: { remaining: number; detail: string },
): string {
  return [
    `[${XAUUSD_M1M5_STRATEGY_VERSION} | ${ctx.accountLabel}] CRITICAL: Friday liquidation INCOMPLETE`,
    p.remaining < 0
      ? 'Broker state could not be read, so remaining exposure is UNKNOWN. This is not a flat state.'
      : `${p.remaining} owned item(s) remain open past the 23:30 Beirut deadline.`,
    p.detail,
    'New entries stay blocked and bounded reconciliation continues.',
  ].join('\n');
}

export function outageMessage(ctx: MessageContext, p: { detail: string }): string {
  return [`[${XAUUSD_M1M5_STRATEGY_VERSION} | ${ctx.accountLabel}] Outage`, p.detail].join('\n');
}

export function recoveryMessage(ctx: MessageContext, p: { detail: string }): string {
  return [`[${XAUUSD_M1M5_STRATEGY_VERSION} | ${ctx.accountLabel}] Recovered`, p.detail].join('\n');
}
