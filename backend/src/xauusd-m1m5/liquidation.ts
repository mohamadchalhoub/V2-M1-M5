/**
 * Friday liquidation (§9.3).
 *
 * Begins at the Friday 23:00 Beirut cutoff, targets broker-confirmed closure
 * before 23:30, and covers **only this application's own M1 and M5 positions
 * and pending orders**.
 *
 * ## The scoping rule is the whole point
 *
 * This machine hosts a deployment that is currently trading. A liquidation
 * routine that selected "all XAUUSD positions" would close that system's
 * positions on a Friday night, and no amount of later apology would undo it.
 * So selection is by magic number against this strategy's own registry, and
 * anything unrecognised is reported and left alone — never closed, never
 * modified, never adopted.
 *
 * That is also why `planLiquidation` takes the full broker position list
 * rather than a pre-filtered one: the filtering IS the safety property, and
 * doing it here, once, in a tested function, is better than trusting every
 * call site to have filtered correctly.
 *
 * ## A submitted close is not a closure
 *
 * §9.3 is explicit, and it is the most common way a liquidation routine lies.
 * A close REQUEST that returned successfully proves the broker accepted the
 * request, not that the position is gone — it may partially fill, it may be
 * rejected downstream, the response may be lost. Completion is therefore
 * defined only by a subsequent broker snapshot showing zero owned exposure,
 * and `isComplete` takes that snapshot rather than a count of requests sent.
 *
 * A missed deadline is reported as a missed deadline, with the exposure that
 * remains. A false flat state is never reported.
 */
import {
  V2_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS,
  V2_LIQUIDATION_MAX_ATTEMPTS,
} from './safety-constants';
import { classifyForeign, isOwnedByThisApplication, timeframeForPosition } from './ownership';
import type { Timeframe } from './spec';

export type LiquidationItemKind = 'POSITION' | 'PENDING_ORDER';

/** A position or order as the broker reports it, before any filtering. */
export interface BrokerItem {
  readonly ticket: string;
  readonly kind: LiquidationItemKind;
  readonly symbol: string;
  /** Null when the broker reports no magic number — a manual trade. */
  readonly magicNumber: number | null;
  readonly volume: number;
}

export interface LiquidationTarget {
  readonly ticket: string;
  readonly kind: LiquidationItemKind;
  readonly timeframe: Timeframe;
  readonly magicNumber: number;
  readonly volume: number;
}

export interface ExcludedItem {
  readonly ticket: string;
  readonly reason: string;
}

export interface LiquidationPlan {
  /** What this application will act on. Nothing else is ever touched. */
  readonly targets: readonly LiquidationTarget[];
  /** What was deliberately left alone, and why — surfaced on the dashboard. */
  readonly excluded: readonly ExcludedItem[];
}

/**
 * Selects what to liquidate.
 *
 * Pending orders are listed before positions, because cancelling a pending
 * order that could still fill removes future exposure, whereas closing a
 * position addresses exposure that already exists. Doing it the other way
 * round leaves a window in which a pending order fills into an account the
 * routine believes it has just flattened.
 */
export function planLiquidation(items: readonly BrokerItem[]): LiquidationPlan {
  const targets: LiquidationTarget[] = [];
  const excluded: ExcludedItem[] = [];

  for (const item of items) {
    if (!isOwnedByThisApplication(item.magicNumber)) {
      excluded.push({ ticket: item.ticket, reason: classifyForeign(item.magicNumber)!.detail });
      continue;
    }
    const timeframe = timeframeForPosition(item.magicNumber);
    if (timeframe === null) {
      // Defensive: ownership said yes but no timeframe resolved. Refusing is
      // the safe direction — an unattributable item is not liquidated blindly.
      excluded.push({
        ticket: item.ticket,
        reason:
          `Magic ${item.magicNumber} is registered to this application but did not resolve to a timeframe. ` +
          'Refusing to act on it rather than guessing.',
      });
      continue;
    }
    targets.push({
      ticket: item.ticket,
      kind: item.kind,
      timeframe,
      magicNumber: item.magicNumber as number,
      volume: item.volume,
    });
  }

  targets.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'PENDING_ORDER' ? -1 : 1;
    return a.ticket.localeCompare(b.ticket);
  });

  return { targets, excluded };
}

export type AttemptDecision = 'SEND' | 'WAIT' | 'ESCALATE';

export interface AttemptState {
  readonly ticket: string;
  readonly attempts: number;
  /** When the most recent request was sent, or null if none has been. */
  readonly lastAttemptAtMs: number | null;
}

/**
 * Whether to send another close/cancel request for an item.
 *
 * Bounded retry, never unbounded (§9.3). An outstanding request is given
 * time to be confirmed before being repeated, because re-sending immediately
 * risks a double close; and after the attempt limit the item is escalated as
 * a critical incident rather than retried forever.
 */
export function nextAttempt(state: AttemptState, nowMs: number): { decision: AttemptDecision; detail: string } {
  if (state.attempts >= V2_LIQUIDATION_MAX_ATTEMPTS) {
    return {
      decision: 'ESCALATE',
      detail:
        `Ticket ${state.ticket} has had ${state.attempts} liquidation attempts without broker-confirmed ` +
        'closure, at the limit. Escalating as a critical incident rather than retrying indefinitely.',
    };
  }
  if (state.lastAttemptAtMs === null) {
    return { decision: 'SEND', detail: `First liquidation attempt for ticket ${state.ticket}.` };
  }
  const elapsedSeconds = (nowMs - state.lastAttemptAtMs) / 1000;
  if (elapsedSeconds < V2_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS) {
    return {
      decision: 'WAIT',
      detail:
        `Ticket ${state.ticket} has an unconfirmed request sent ${elapsedSeconds.toFixed(0)}s ago; waiting up ` +
        `to ${V2_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS}s before re-querying broker state. Re-sending now could ` +
        'close the position twice.',
    };
  }
  return {
    decision: 'SEND',
    detail:
      `Ticket ${state.ticket} remained unconfirmed for ${elapsedSeconds.toFixed(0)}s; re-querying and ` +
      `retrying (attempt ${state.attempts + 1} of ${V2_LIQUIDATION_MAX_ATTEMPTS}).`,
  };
}

export type LiquidationStatus =
  | 'NOT_DUE'
  | 'IN_PROGRESS'
  | 'CONFIRMED_FLAT'
  | 'DEADLINE_MISSED';

export interface LiquidationVerdict {
  readonly status: LiquidationStatus;
  readonly remainingOwned: number;
  readonly detail: string;
}

export interface CompletionInput {
  /** True once the Friday cutoff has been reached (§9.3). */
  readonly liquidationDue: boolean;
  /** True once 23:30 Beirut has passed. */
  readonly deadlinePassed: boolean;
  /**
   * A FRESH broker snapshot, not a tally of requests sent. Completion is
   * defined by what the broker reports, never by what this application asked
   * for.
   */
  readonly brokerSnapshot: readonly BrokerItem[] | null;
}

export function evaluateCompletion(input: CompletionInput): LiquidationVerdict {
  if (!input.liquidationDue) {
    return { status: 'NOT_DUE', remainingOwned: 0, detail: 'Friday liquidation is not due.' };
  }

  if (input.brokerSnapshot === null) {
    // Unknown exposure is never reported as flat. §9.3 forbids a false flat
    // state, and "we could not ask" is not evidence of zero.
    return {
      status: input.deadlinePassed ? 'DEADLINE_MISSED' : 'IN_PROGRESS',
      remainingOwned: -1,
      detail:
        'Broker state could not be read, so owned exposure is UNKNOWN. This is never reported as flat. ' +
        'New entries stay blocked and reconciliation continues.',
    };
  }

  const owned = planLiquidation(input.brokerSnapshot).targets;

  if (owned.length === 0) {
    return {
      status: 'CONFIRMED_FLAT',
      remainingOwned: 0,
      detail:
        'Broker-confirmed: this application owns no open positions and no pending orders. Positions belonging ' +
        'to other applications are unaffected and were never included.',
    };
  }

  if (input.deadlinePassed) {
    return {
      status: 'DEADLINE_MISSED',
      remainingOwned: owned.length,
      detail:
        `The Friday 23:30 Beirut deadline passed with ${owned.length} owned item(s) still open: ` +
        `${owned.map((t) => `${t.timeframe} ${t.kind} ${t.ticket}`).join(', ')}. Raising a critical incident; ` +
        'new entries stay blocked and bounded reconciliation continues.',
    };
  }

  return {
    status: 'IN_PROGRESS',
    remainingOwned: owned.length,
    detail: `Liquidating ${owned.length} owned item(s): ${owned.map((t) => `${t.timeframe} ${t.ticket}`).join(', ')}.`,
  };
}
