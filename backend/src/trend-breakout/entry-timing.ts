/**
 * §8 — entry timing/execution rules, kept separate from `sl-tp.ts` (distance
 * sizing) and `signal-engine.ts` (whether a signal exists at all): this
 * module only answers "is it still valid to act on this specific signal
 * RIGHT NOW, and at what price."
 */

export const SETUP_EXPIRY_MS = 60_000; // "the setup expires 60 seconds after S's closing time"
export const GAP_CHASE_ATR_MULTIPLIER = 0.25;

/** §8 — "No entry at or after expiry." Strict >= on purpose — the boundary instant itself is already too late, mirroring the schedule window's own inclusive/exclusive convention being taken seriously at the edges. */
export function isSignalExpired(signalCloseAt: Date, now: Date): boolean {
  return now.getTime() - signalCloseAt.getTime() >= SETUP_EXPIRY_MS;
}

export interface Quote {
  bid: number;
  ask: number;
  /** When this quote was observed — used for both the freshness/max-quote-age gate (§10) and as this decision's `quoteAt`. */
  quotedAt: Date;
}

/** §8 — "Buy uses ask; sell uses bid." The executable price a market order at this side would actually fill at. */
export function selectExecutablePrice(side: 'BUY' | 'SELL', quote: Quote): number {
  return side === 'BUY' ? quote.ask : quote.bid;
}

export interface GapChaseCheck {
  passed: boolean;
  reason: string;
}

/**
 * §8 — "Require absolute difference between executable entry price and
 * S.close <= 0.25 x A." Guards against chasing a price that has already run
 * away from the signal by the time an order can actually be sent (network/
 * queue delay, or a genuinely fast subsequent move) — distinct from the
 * 60-second hard expiry above; a price can gap-chase-fail well within the
 * 60s window.
 */
export function checkGapChaseFilter(executablePrice: number, signalClose: number, atr: number): GapChaseCheck {
  const maxDrift = GAP_CHASE_ATR_MULTIPLIER * atr;
  const drift = Math.abs(executablePrice - signalClose);
  if (drift > maxDrift) {
    return { passed: false, reason: `Executable price ${executablePrice} has drifted ${drift.toFixed(6)} from S.close ${signalClose} — exceeds ${GAP_CHASE_ATR_MULTIPLIER} x A (${maxDrift.toFixed(6)}); refusing to chase.` };
  }
  return { passed: true, reason: `Executable price ${executablePrice} is within ${GAP_CHASE_ATR_MULTIPLIER} x A of S.close ${signalClose} (drift ${drift.toFixed(6)} <= ${maxDrift.toFixed(6)}).` };
}

/**
 * Assembles the durable identity §8 asks for ("account, strategy version,
 * instrument, direction, and signal-close timestamp"). The actual
 * uniqueness ENFORCEMENT is the database's own
 * `TrendBreakoutDecision`(`accountId`, `strategyVersion`, `instrument`,
 * `signalCloseAt`) constraint (schema.prisma) — this is just the same key
 * assembled as a human-readable string for logging/comment fields, so a
 * broker order comment can carry it without a second source of truth.
 */
export function buildSignalRequestKey(accountId: string, strategyVersion: string, instrument: string, direction: 'BUY' | 'SELL', signalCloseAt: Date): string {
  return `${accountId}:${strategyVersion}:${instrument}:${direction}:${signalCloseAt.toISOString()}`;
}
