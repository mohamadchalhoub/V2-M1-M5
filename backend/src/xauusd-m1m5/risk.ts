/**
 * Risk gates and the final pre-send check (§7).
 *
 * Every cap here is carried over unweakened, and every one is a percentage of
 * **live, real-queried account equity** rather than a remembered figure — an
 * equity number read at startup and reused all day describes an account that
 * no longer exists.
 *
 * ## Combined risk spans both timeframes, including reserved risk
 *
 * This is the gate most easily got wrong in a two-path strategy. The combined
 * cap is not "the risk of the order being submitted"; it is the risk of that
 * order PLUS every position already open PLUS every order already reserved
 * but not yet filled. M1 and M5 can each hold exposure, and a reservation
 * that has not filled yet is still risk the account is committed to.
 *
 * Counting only open positions would let two orders, submitted a second
 * apart, each pass a 1% cap and leave the account at 2%.
 *
 * ## The pre-send gate is separate on purpose
 *
 * `evaluateRisk` runs when a candidate is formed. `preSendCheck` runs
 * immediately before the order is handed to the broker, including on every
 * retry. The gap between them is real — a database write, a queue, a
 * collector poll — and the schedule, the quote and the drift can all change
 * inside it. §7 and §9.2 both require the boundary to be rechecked at the
 * actual moment of submission rather than trusted from the earlier decision.
 */
import { entryDriftPoints, verifyBracketDistances } from './brackets';
import {
  V2_COMBINED_RISK_CAP_PCT,
  V2_DAILY_LOSS_CAP_PCT,
  V2_DRAWDOWN_CAP_PCT,
  V2_MAX_ENTRY_DEVIATION_POINTS,
  V2_MAX_SIGNAL_AGE_SECONDS,
  V2_QUOTE_MAX_STALENESS_SECONDS,
  V2_STOP_RISK_CAP_PCT,
} from './safety-constants';
import type { Direction, Timeframe } from './spec';

export type RiskRefusal =
  | 'NO_EQUITY'
  | 'STOP_RISK_CAP'
  | 'COMBINED_RISK_CAP'
  | 'DAILY_LOSS_CAP'
  | 'DRAWDOWN_CAP'
  | 'INSUFFICIENT_MARGIN';

export interface AccountRiskState {
  /** Live equity, queried now. Null when it could not be read, which blocks. */
  readonly equity: number | null;
  /** Free margin available for a new position. Null blocks. */
  readonly freeMargin: number | null;
  /** Realized + floating loss so far in the current trading day, as a positive number. */
  readonly dayLoss: number;
  /** Drawdown from peak equity, as a positive number. */
  readonly drawdown: number;
}

/** One unit of exposure already committed — open or merely reserved. */
export interface CommittedRisk {
  readonly timeframe: Timeframe;
  /** Account-currency loss if this position hits its stop. */
  readonly stopRisk: number;
  /** True when this is a reservation that has not filled yet. */
  readonly reserved: boolean;
}

export interface RiskInput {
  readonly account: AccountRiskState;
  /** Account-currency loss if THIS candidate hits its stop. */
  readonly candidateStopRisk: number;
  /** Margin the broker requires for this order. */
  readonly candidateMarginRequired: number;
  /** Everything already committed, across BOTH timeframes. */
  readonly committed: readonly CommittedRisk[];
}

export interface RiskVerdict {
  readonly approved: boolean;
  readonly refusal: RiskRefusal | null;
  readonly detail: string | null;
  /** The numbers the decision was made on, persisted as evidence. */
  readonly evidence: {
    readonly equity: number | null;
    readonly candidateStopRiskPct: number | null;
    readonly committedStopRisk: number;
    readonly combinedStopRiskPct: number | null;
    readonly dayLossPct: number | null;
    readonly drawdownPct: number | null;
  };
}

export function evaluateRisk(input: RiskInput): RiskVerdict {
  const { account, candidateStopRisk, candidateMarginRequired, committed } = input;

  const committedStopRisk = committed.reduce((sum, c) => sum + c.stopRisk, 0);

  const blank = {
    equity: account.equity,
    candidateStopRiskPct: null,
    committedStopRisk,
    combinedStopRiskPct: null,
    dayLossPct: null,
    drawdownPct: null,
  };

  // Equity is the denominator of every cap. Without it no cap can be
  // evaluated, so the answer is refusal, never "probably fine".
  if (account.equity === null || !Number.isFinite(account.equity) || account.equity <= 0) {
    return {
      approved: false,
      refusal: 'NO_EQUITY',
      detail:
        'Live account equity could not be read, so no risk cap can be evaluated. Execution is refused rather ' +
        'than proceeding on an assumed or remembered figure.',
      evidence: blank,
    };
  }

  const equity = account.equity;
  const pct = (amount: number) => (amount / equity) * 100;

  const candidateStopRiskPct = pct(candidateStopRisk);
  const combinedStopRiskPct = pct(candidateStopRisk + committedStopRisk);
  const dayLossPct = pct(account.dayLoss);
  const drawdownPct = pct(account.drawdown);

  const evidence = {
    equity,
    candidateStopRiskPct,
    committedStopRisk,
    combinedStopRiskPct,
    dayLossPct,
    drawdownPct,
  };

  const refuse = (refusal: RiskRefusal, detail: string): RiskVerdict => ({
    approved: false,
    refusal,
    detail,
    evidence,
  });

  // Ordered worst-first: an account in drawdown should say so rather than
  // reporting a per-trade cap that is merely the first one tested.
  if (drawdownPct > V2_DRAWDOWN_CAP_PCT) {
    return refuse(
      'DRAWDOWN_CAP',
      `Drawdown is ${drawdownPct.toFixed(2)}% of equity, above the ${V2_DRAWDOWN_CAP_PCT}% cap.`,
    );
  }
  if (dayLossPct > V2_DAILY_LOSS_CAP_PCT) {
    return refuse(
      'DAILY_LOSS_CAP',
      `Loss so far today is ${dayLossPct.toFixed(2)}% of equity, above the ${V2_DAILY_LOSS_CAP_PCT}% cap.`,
    );
  }
  if (candidateStopRiskPct > V2_STOP_RISK_CAP_PCT) {
    return refuse(
      'STOP_RISK_CAP',
      `This order risks ${candidateStopRiskPct.toFixed(3)}% of equity at its stop, above the ` +
        `${V2_STOP_RISK_CAP_PCT}% per-trade cap. The volume is NOT reduced to fit.`,
    );
  }
  if (combinedStopRiskPct > V2_COMBINED_RISK_CAP_PCT) {
    const reserved = committed.filter((c) => c.reserved).length;
    return refuse(
      'COMBINED_RISK_CAP',
      `Combined stop risk across both timeframes would be ${combinedStopRiskPct.toFixed(3)}% of equity, above ` +
        `the ${V2_COMBINED_RISK_CAP_PCT}% cap. Already committed: ${committed.length} exposure(s) ` +
        `(${reserved} reserved but not yet filled) totalling ${committedStopRisk.toFixed(2)}.`,
    );
  }
  if (account.freeMargin === null || !Number.isFinite(account.freeMargin)) {
    return refuse('INSUFFICIENT_MARGIN', 'Free margin could not be read; execution is refused rather than assumed.');
  }
  if (account.freeMargin < candidateMarginRequired) {
    return refuse(
      'INSUFFICIENT_MARGIN',
      `Free margin ${account.freeMargin.toFixed(2)} is below the ${candidateMarginRequired.toFixed(2)} this ` +
        'order requires.',
    );
  }

  return { approved: true, refusal: null, detail: null, evidence };
}

export type PreSendRefusal =
  | 'SIGNAL_TOO_OLD'
  | 'QUOTE_STALE'
  | 'QUOTE_FUTURE_DATED'
  | 'ENTRY_DRIFT_EXCEEDED'
  | 'BRACKETS_INVALID'
  | 'SCHEDULE_CLOSED'
  | 'ENTRIES_BLOCKED';

export interface PreSendInput {
  readonly timeframe: Timeframe;
  readonly direction: Direction;
  /** When the observation that produced this signal happened. */
  readonly signalObservedAtMs: number;
  /** Price the signal was formed at. */
  readonly signalPrice: number;
  /** A FRESHLY fetched quote, read immediately before this attempt (§10). */
  readonly freshQuote: { bid: number; ask: number; tickAtMs: number };
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly pointSize: number;
  /** Explicit server evaluation instant. */
  readonly nowMs: number;
  /** Rechecked at the boundary, not trusted from the earlier decision (§9.2). */
  readonly scheduleAllowsEntries: boolean;
  readonly scheduleDetail: string;
  /** Kill switch / stop-new-entries, rechecked now. */
  readonly entriesBlockedReason: string | null;
}

export interface PreSendVerdict {
  readonly ok: boolean;
  readonly refusal: PreSendRefusal | null;
  readonly detail: string | null;
}

/**
 * The final gate, run immediately before the order is handed to the broker
 * and again before every retry.
 *
 * Passing `evaluateRisk` earlier proves nothing here: time has passed, and
 * the things that changed in between are exactly the things this checks.
 */
export function preSendCheck(input: PreSendInput): PreSendVerdict {
  const refuse = (refusal: PreSendRefusal, detail: string): PreSendVerdict => ({ ok: false, refusal, detail });

  // The schedule is rechecked FIRST: a Friday cutoff crossed while the order
  // sat in a queue must cancel it, whatever else is true.
  if (!input.scheduleAllowsEntries) {
    return refuse('SCHEDULE_CLOSED', `Refusing to send at the final pre-send check: ${input.scheduleDetail}`);
  }
  if (input.entriesBlockedReason !== null) {
    return refuse('ENTRIES_BLOCKED', `Refusing to send at the final pre-send check: ${input.entriesBlockedReason}`);
  }

  const signalAgeSeconds = (input.nowMs - input.signalObservedAtMs) / 1000;
  if (signalAgeSeconds > V2_MAX_SIGNAL_AGE_SECONDS) {
    return refuse(
      'SIGNAL_TOO_OLD',
      `Signal is ${signalAgeSeconds.toFixed(1)}s old at the pre-send check, beyond the ` +
        `${V2_MAX_SIGNAL_AGE_SECONDS}s limit. An intrabar crossing that has sat this long is no longer the ` +
        'event the rules described, so it is dropped rather than submitted late.',
    );
  }

  const quoteAgeSeconds = (input.nowMs - input.freshQuote.tickAtMs) / 1000;
  if (quoteAgeSeconds > V2_QUOTE_MAX_STALENESS_SECONDS) {
    return refuse(
      'QUOTE_STALE',
      `The quote is ${quoteAgeSeconds.toFixed(1)}s old at the pre-send check, beyond the ` +
        `${V2_QUOTE_MAX_STALENESS_SECONDS}s limit.`,
    );
  }
  if (quoteAgeSeconds < -2) {
    return refuse(
      'QUOTE_FUTURE_DATED',
      `The quote is dated ${Math.abs(quoteAgeSeconds).toFixed(1)}s in the future, beyond what clock skew ` +
        'explains. This indicates a wrong timestamp conversion, not a very fresh quote.',
    );
  }

  const executable = input.direction === 'BUY' ? input.freshQuote.ask : input.freshQuote.bid;
  const drift = entryDriftPoints(input.signalPrice, executable, input.pointSize);
  if (drift > V2_MAX_ENTRY_DEVIATION_POINTS) {
    return refuse(
      'ENTRY_DRIFT_EXCEEDED',
      `Price has moved ${drift.toFixed(0)} points from the ${input.signalPrice} the signal was formed at, ` +
        `beyond the ${V2_MAX_ENTRY_DEVIATION_POINTS}-point limit. The entry is skipped, never chased.`,
    );
  }

  const brackets = verifyBracketDistances(
    input.direction,
    input.entryPrice,
    input.stopLoss,
    input.takeProfit,
    input.pointSize,
  );
  if (!brackets.ok) {
    return refuse('BRACKETS_INVALID', `Refusing to send: ${brackets.detail}`);
  }

  return { ok: true, refusal: null, detail: null };
}
