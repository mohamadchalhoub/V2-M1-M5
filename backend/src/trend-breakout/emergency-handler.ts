/**
 * §11 — emergency handling for a confirmed missing or unverifiable
 * protective stop-loss. "An existing position's protection must operate
 * independently of AI availability and the entry schedule" — there is no
 * AI anywhere in this strategy (§1) and this handler never checks the
 * Beirut window; it is meant to run any time a position is found unprotected.
 *
 * Every broker interaction is an injected async "port" so this whole
 * decision tree is unit-testable with mocks, per this task's explicit
 * instruction ("test emergency behavior with mocks only during this
 * task") — nothing here imports the collector, MT5, or any real network
 * call.
 *
 * Design decision, stated plainly because the spec's 5 steps don't spell
 * this out explicitly: `blockEntries` is ALWAYS true once this handler
 * runs at all (i.e. whenever a missing/unverifiable SL was confirmed in
 * the first place — that confirmation is this function's precondition,
 * not something it re-decides). Whether the position ends up protected or
 * closed cleanly (MITIGATED) or not (UNRESOLVED) changes the incident's
 * recorded status, but NOT whether entries stay blocked — clearing that
 * block is a separate, explicit human action (mirroring §10's drawdown
 * gate, which is the same "block until explicit review" pattern already
 * used elsewhere in this design), never something this function
 * auto-clears just because its own immediate remediation happened to
 * succeed.
 */

export interface EmergencyPositionState {
  exists: boolean;
  ticket: number | null;
  side: 'BUY' | 'SELL' | null;
  volume: number | null;
  stopLoss: number | null; // null/0 = no SL currently attached
}

/** A query that FAILED (broker didn't answer) is never conflated with a query that CONFIRMED "no position" — same distinction executor.py's `ReconciliationQueryFailed` already enforces on the Python side. */
export type PositionQueryResult = { ok: true; state: EmergencyPositionState } | { ok: false; reason: string };

export type BrokerActionOutcome = 'OK' | 'FAILED' | 'UNKNOWN';

export interface EmergencyHandlerPorts {
  /** Authoritative broker position lookup — must be a FRESH query each call, never a cached state. */
  getPositionState: () => Promise<PositionQueryResult>;
  setStopLoss: (intendedSl: number) => Promise<BrokerActionOutcome>;
  /** Closes a position BY TICKET — this signature intentionally has no way to express "open an opposite order instead"; §11 is explicit that substitution is never acceptable. */
  closePosition: (ticket: number, side: 'BUY' | 'SELL', volume: number) => Promise<BrokerActionOutcome>;
  emitCriticalAlert: (message: string) => Promise<void>;
  persistIncident: (incident: { status: 'MITIGATED' | 'UNRESOLVED'; detail: Record<string, unknown> }) => Promise<void>;
}

export type EmergencyIncidentStatus = 'MITIGATED' | 'UNRESOLVED';

export interface EmergencyOutcome {
  /** Always true — see the module comment above. */
  blockEntries: true;
  status: EmergencyIncidentStatus;
  narrative: string[];
}

async function log(narrative: string[], message: string): Promise<void> {
  narrative.push(message);
}

/**
 * Runs steps 1-5 of §11 in order. Called with the INTENDED stop-loss price
 * (what this position was supposed to have) once a caller has already
 * confirmed the SL is missing or unverifiable — this function does not
 * itself decide "is the SL missing," it responds to that already having
 * been confirmed.
 */
export async function handleMissingStopLoss(intendedSl: number, ports: EmergencyHandlerPorts): Promise<EmergencyOutcome> {
  const narrative: string[] = [];
  await log(narrative, `Missing/unverifiable protective stop-loss confirmed — beginning emergency handling (intended SL ${intendedSl}).`);

  // Step 1 — attempt to establish the intended SL ONCE.
  const setResult = await ports.setStopLoss(intendedSl);
  await log(narrative, `Step 1 (attempt to (re)establish SL): ${setResult}.`);

  // Step 2 — verify AUTHORITATIVE position state (never trust step 1's own return value as proof).
  const verify1 = await ports.getPositionState();
  if (!verify1.ok) {
    await log(narrative, `Step 2 (verify): position-state query itself FAILED (${verify1.reason}) — cannot confirm protection either way.`);
    return finish('UNRESOLVED', narrative, ports, { intendedSl, setResult, verifyError: verify1.reason });
  }
  if (!verify1.state.exists) {
    // The position is already gone (closed by SL/TP, or externally) — nothing left to protect or close.
    await log(narrative, 'Step 2 (verify): position no longer exists — nothing further to protect or close.');
    return finish('MITIGATED', narrative, ports, { intendedSl, setResult, outcome: 'position_already_closed' });
  }
  const nowProtected = Boolean(verify1.state.stopLoss);
  await log(narrative, `Step 2 (verify): position ${verify1.state.ticket} SL is now ${nowProtected ? 'PRESENT' : 'ABSENT'} (${verify1.state.stopLoss ?? 'none'}).`);
  if (nowProtected) {
    return finish('MITIGATED', narrative, ports, { intendedSl, setResult, resultingSl: verify1.state.stopLoss });
  }

  // Step 3 — protection remains absent: attempt a full close. Re-verify
  // identity/volume from THIS SAME fresh query (verify1), never from an
  // earlier cached read — "before a recovery close, verify current
  // position identity and remaining volume."
  if (verify1.state.ticket === null || verify1.state.side === null || verify1.state.volume === null) {
    await log(narrative, 'Step 3 (close): position exists but ticket/side/volume could not be confirmed — refusing to send a close against an unidentified position.');
    return finish('UNRESOLVED', narrative, ports, { intendedSl, setResult, reason: 'incomplete_position_identity' });
  }
  await log(narrative, `Step 3 (close): sending a full close for ticket ${verify1.state.ticket}, side ${verify1.state.side}, volume ${verify1.state.volume}.`);
  const closeResult = await ports.closePosition(verify1.state.ticket, verify1.state.side, verify1.state.volume);
  await log(narrative, `Step 3 (close) result: ${closeResult}.`);

  if (closeResult === 'FAILED' || closeResult === 'UNKNOWN') {
    // "Do not claim the position is closed. Keep the account blocked.
    // Reconcile using broker state/history. Continue explicit incident
    // handling without blind duplicate submissions." — no retry loop here;
    // this is exactly the UNRESOLVED terminal state a human/later
    // reconciliation pass must pick up.
    await log(narrative, `Close ${closeResult === 'FAILED' ? 'failed' : 'outcome unknown'} — NOT claiming closed, NOT retrying blindly. Reconciliation against broker history is required.`);
    return finish('UNRESOLVED', narrative, ports, { intendedSl, setResult, closeResult, ticket: verify1.state.ticket });
  }

  // closeResult === 'OK' — verify AGAIN with a fresh query rather than trusting the close call's own return value.
  const verify2 = await ports.getPositionState();
  if (!verify2.ok) {
    await log(narrative, `Post-close verification query FAILED (${verify2.reason}) — cannot confirm the close actually took effect.`);
    return finish('UNRESOLVED', narrative, ports, { intendedSl, setResult, closeResult, verifyError: verify2.reason });
  }
  if (verify2.state.exists) {
    await log(narrative, 'Post-close verification: a position STILL exists — the close did not actually clear it. Treating as unresolved.');
    return finish('UNRESOLVED', narrative, ports, { intendedSl, setResult, closeResult, stillOpenTicket: verify2.state.ticket });
  }
  await log(narrative, 'Post-close verification: confirmed no position remains.');
  return finish('MITIGATED', narrative, ports, { intendedSl, setResult, closeResult, outcome: 'closed_and_verified' });
}

async function finish(status: EmergencyIncidentStatus, narrative: string[], ports: EmergencyHandlerPorts, detail: Record<string, unknown>): Promise<EmergencyOutcome> {
  // Step 4 — block new entries (always; see module comment).
  // Step 5 — persist the incident and emit a critical alert.
  await ports.persistIncident({ status, detail });
  await ports.emitCriticalAlert(
    `[TREND-BREAKOUT EMERGENCY] Missing/unverifiable protective stop-loss — status=${status}. New entries are blocked pending explicit review. Narrative: ${narrative.join(' | ')}`,
  );
  return { blockEntries: true, status, narrative };
}
