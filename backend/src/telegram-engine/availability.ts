/**
 * Whether Engine B may execute RIGHT NOW.
 *
 * ## The one thing this file must get right
 *
 * It does not import `../xauusd-m1m5/schedule`, and it must never begin to.
 *
 * Engine A pauses new entries 14:00–19:00 and 23:30–01:00 Beirut and stops
 * entering on Friday at 23:00. Those are Engine A STRATEGY rules. Engine B
 * has no time-of-day pause at all: a valid, fresh signal published at 14:05,
 * 15:30, 17:00, 18:59 or 00:30 Beirut is executed then, and this module has
 * no code path that can return a schedule block for one. There is no
 * `SCHEDULE_BLOCKED` in the verdict type, which is what makes that a
 * compile-time guarantee rather than a promise.
 *
 * Schedule eligibility is strategy-scoped by construction: each engine asks
 * its own module, and there is no shared "may we trade?" function containing
 * either engine's pauses for the other to inherit.
 *
 * ## "Always" does not mean "regardless of physics"
 *
 * What Engine B does still require is that an order is actually possible:
 * the terminal connected to the right account and permitted to trade, the
 * symbol tradable, the broker's session genuinely open, an executable quote,
 * enough margin. Those are ACCOUNT-level facts, shared by both engines
 * because both engines use one MT5 account — not Engine A rules wearing a
 * different name.
 *
 * ## A closed market is terminal, not a queue
 *
 * When the broker's XAUUSD market is closed the signal is refused with
 * `TELEGRAM_MARKET_CLOSED`, recorded, and consumed permanently. It is never
 * held for reopening and never replayed, on Monday or ever — by then the
 * price the channel published describes a market that no longer exists, and
 * the 60-second lifetime would refuse it anyway. Weekend closure is this same
 * case and gets this same answer; Engine B has no Friday cutoff of its own
 * and does not inherit Engine A's.
 */
import { evaluateReadiness, type Mt5PermissionSnapshot } from '../xauusd-m1m5/mt5-readiness';
import { telegramEntriesBlockedByControls } from './controls';
import { TELEGRAM_QUOTE_MAX_STALENESS_MS } from './safety-constants';
import { TELEGRAM_SPEC } from './spec';

/**
 * Every reason Engine B can refuse for availability. Note what is absent:
 * no pause, no cutoff, no schedule of any kind.
 */
export type AvailabilityBlock =
  /** Global or Telegram-engine kill switch. */
  | 'TELEGRAM_KILL_SWITCH'
  /** Terminal/account permissions, identity or connection (shared safety). */
  | 'TELEGRAM_MT5_NOT_READY'
  /** The broker's XAUUSD session is closed, or its state is unknown. */
  | 'TELEGRAM_MARKET_CLOSED'
  /** The symbol exists but the broker currently disallows trading it. */
  | 'TELEGRAM_SYMBOL_NOT_TRADABLE'
  /** No usable, sufficiently recent executable quote. */
  | 'TELEGRAM_NO_EXECUTABLE_QUOTE'
  /** Reconciliation of prior Telegram orders has not finished. */
  | 'TELEGRAM_RECOVERY_INCOMPLETE';

/** The live facts availability is decided from. Every unknown blocks. */
export interface AvailabilityInput {
  readonly nowMs: number;
  readonly snapshot: Mt5PermissionSnapshot | null;
  readonly expectedLoginId: string | null;
  /**
   * Whether the BROKER reports its XAUUSD session open. `null` means the
   * collector could not determine it, which blocks: an unknown session is
   * never assumed open, and assuming it is how an engine ends up submitting
   * into a closed market and calling the rejection a broker fault.
   */
  readonly symbolSessionOpen: boolean | null;
  /** Whether the broker currently permits trading this symbol at all. */
  readonly symbolTradable: boolean | null;
  readonly quote: { bid: number; ask: number; tickAtMs: number } | null;
  /** Startup/reconnect reconciliation of Engine B's own orders has finished. */
  readonly recoveryComplete: boolean;
}

export interface AvailabilityVerdict {
  readonly available: boolean;
  readonly block: AvailabilityBlock | null;
  readonly detail: string;
  /**
   * True when the refusal is a closed market specifically — the case that
   * must be consumed permanently rather than retried. Callers branch on this
   * rather than string-matching the block code.
   */
  readonly marketClosed: boolean;
}

export function evaluateTelegramAvailability(input: AvailabilityInput): AvailabilityVerdict {
  const refuse = (block: AvailabilityBlock, detail: string): AvailabilityVerdict => ({
    available: false,
    block,
    detail,
    marketClosed: block === 'TELEGRAM_MARKET_CLOSED',
  });

  const controls = telegramEntriesBlockedByControls();
  if (controls !== null) return refuse('TELEGRAM_KILL_SWITCH', controls);

  // Shared account safety: identity, DEMO verification, terminal connection,
  // terminal and broker permissions, hedging. Reused from Engine A's module
  // because it is infrastructure — it encodes what MT5 requires of anyone,
  // and contains no RSI rule, no threshold and no schedule.
  const readiness = evaluateReadiness({
    snapshot: input.snapshot,
    expectedLoginId: input.expectedLoginId,
    nowMs: input.nowMs,
  });
  if (!readiness.ready) {
    return refuse(
      'TELEGRAM_MT5_NOT_READY',
      `MT5 is not ready to trade: ${readiness.blockers.map((b) => `${b.code} (${b.origin})`).join(', ')}.`,
    );
  }

  if (input.symbolSessionOpen !== true) {
    return refuse(
      'TELEGRAM_MARKET_CLOSED',
      input.symbolSessionOpen === null
        ? `The broker's ${TELEGRAM_SPEC.symbol} session state could not be determined, which blocks rather than ` +
            'permits. The signal is recorded, skipped and consumed permanently — it is never queued for reopening.'
        : `The broker's ${TELEGRAM_SPEC.symbol} market is closed. The signal is recorded, skipped and consumed ` +
            'permanently: it is never queued and never replayed when the market reopens.',
    );
  }

  if (input.symbolTradable !== true) {
    return refuse(
      'TELEGRAM_SYMBOL_NOT_TRADABLE',
      input.symbolTradable === null
        ? `Whether the broker permits trading ${TELEGRAM_SPEC.symbol} could not be determined; execution is blocked.`
        : `The broker currently disallows trading ${TELEGRAM_SPEC.symbol} (quotes only, or close-only).`,
    );
  }

  const quote = input.quote;
  if (quote === null || ![quote.bid, quote.ask].every((p) => Number.isFinite(p) && p > 0) || quote.ask < quote.bid) {
    return refuse(
      'TELEGRAM_NO_EXECUTABLE_QUOTE',
      quote === null ? 'No quote is available.' : `Quote is unusable: bid=${quote.bid}, ask=${quote.ask}.`,
    );
  }
  const quoteAgeMs = input.nowMs - quote.tickAtMs;
  if (quoteAgeMs > TELEGRAM_QUOTE_MAX_STALENESS_MS) {
    return refuse(
      'TELEGRAM_NO_EXECUTABLE_QUOTE',
      `The last tick is ${(quoteAgeMs / 1000).toFixed(1)}s old, beyond the ` +
        `${TELEGRAM_QUOTE_MAX_STALENESS_MS / 1000}s budget. A stale quote cannot show that price has run away ` +
        'from the published entry, which is the one thing the deviation check exists to catch.',
    );
  }

  if (!input.recoveryComplete) {
    return refuse(
      'TELEGRAM_RECOVERY_INCOMPLETE',
      'Reconciliation of this engine’s prior orders has not finished. Until it has, an order whose outcome is ' +
        'unknown could be duplicated by a new submission.',
    );
  }

  return {
    available: true,
    block: null,
    marketClosed: false,
    detail:
      'The account is ready and the market is open. Engine B has no time-of-day pause: the RSI engine’s ' +
      '14:00–19:00 and 23:30–01:00 Beirut pauses and its Friday cutoff do not apply here.',
  };
}
