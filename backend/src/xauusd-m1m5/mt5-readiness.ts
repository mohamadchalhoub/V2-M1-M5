/**
 * MT5 execution readiness (§8).
 *
 * The single rule this module exists to enforce: **fresh quotes are not
 * permission to trade.**
 *
 * That confusion is easy to fall into and expensive to discover. A terminal
 * with `trade_allowed = false`, or an account with `trade_expert = false`,
 * streams perfectly good prices right up until the moment an order is
 * rejected. A dashboard that reports "connected, data fresh, ready" from the
 * quote feed alone is reporting something it has not checked.
 *
 * So every one of §8's checks is evaluated explicitly, and **unknown is
 * treated as blocking**, never as permissive. A permission this code could
 * not read is a permission it must not assume.
 *
 * ## Staleness
 *
 * Permission state is itself perishable. An operator can disable algorithmic
 * trading in the terminal at any moment, and a snapshot taken ten minutes ago
 * does not describe now. A snapshot older than the freshness budget is
 * therefore a blocker in its own right, reported as such rather than silently
 * trusted.
 *
 * ## What this module does not do
 *
 * It never toggles a permission. §8 forbids automatically changing settings on
 * any terminal, and that prohibition matters especially here: this project
 * shares a machine with a deployment that is currently trading, and "helpfully"
 * enabling something on the wrong terminal would be an unrecoverable mistake.
 * Every blocker is reported for a human to act on.
 */
import { V2_SYMBOL } from './safety-constants';

/** How old a permission snapshot may be before it is itself a blocker. */
export const PERMISSION_SNAPSHOT_MAX_AGE_MS = 120_000;

/**
 * What the collector reports about the terminal and account.
 *
 * Every permission is `boolean | null`, and `null` means "the collector could
 * not determine this". That is a deliberate three-state design: a two-state
 * boolean forces an unknown to be encoded as one of the two answers, and
 * whichever is chosen is wrong half the time — encoding it as `true` would let
 * an unreadable permission look like a granted one.
 */
export interface Mt5PermissionSnapshot {
  /** When the collector captured this, UTC ms. */
  readonly capturedAtMs: number;
  /** The account the terminal is actually logged into. */
  readonly loginId: string | null;
  /** MT5 ACCOUNT_TRADE_MODE — DEMO / CONTEST / REAL, or null if unknown. */
  readonly tradeMode: 'DEMO' | 'CONTEST' | 'REAL' | null;
  /** Terminal reports itself connected to the trade server. */
  readonly terminalConnected: boolean | null;
  /** Terminal-level "Algo Trading" switch. */
  readonly terminalTradeAllowed: boolean | null;
  /** Terminal-level API disable flag. Note the INVERTED sense: true is bad. */
  readonly terminalTradeApiDisabled: boolean | null;
  /** Account-level trading permission, set by the broker. */
  readonly accountTradeAllowed: boolean | null;
  /** Account-level expert-advisor permission, set by the broker. */
  readonly accountTradeExpert: boolean | null;
  /** RETAIL_HEDGING / RETAIL_NETTING / EXCHANGE, or null if unknown. */
  readonly marginMode: 'RETAIL_HEDGING' | 'RETAIL_NETTING' | 'EXCHANGE' | null;
}

export type BlockerCode =
  | 'NO_SNAPSHOT'
  | 'SNAPSHOT_STALE'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'ACCOUNT_IDENTITY_UNKNOWN'
  | 'NOT_DEMO'
  | 'TRADE_MODE_UNKNOWN'
  | 'TERMINAL_DISCONNECTED'
  | 'TERMINAL_CONNECTION_UNKNOWN'
  | 'TERMINAL_TRADE_NOT_ALLOWED'
  | 'TERMINAL_TRADE_ALLOWED_UNKNOWN'
  | 'TERMINAL_TRADE_API_DISABLED'
  | 'TERMINAL_TRADE_API_UNKNOWN'
  | 'ACCOUNT_TRADE_NOT_ALLOWED'
  | 'ACCOUNT_TRADE_ALLOWED_UNKNOWN'
  | 'ACCOUNT_TRADE_EXPERT_DISABLED'
  | 'ACCOUNT_TRADE_EXPERT_UNKNOWN'
  | 'HEDGING_UNSUPPORTED'
  | 'HEDGING_UNKNOWN';

export interface Blocker {
  readonly code: BlockerCode;
  /** Operator-facing explanation, including what to do about it. */
  readonly detail: string;
  /**
   * Whether this originates in the TERMINAL (operator can fix locally) or at
   * the BROKER (only the broker can change it). §8 requires the two be
   * distinguished rather than reported as one undifferentiated failure.
   */
  readonly origin: 'TERMINAL' | 'BROKER' | 'COLLECTOR' | 'CONFIGURATION';
}

export interface ReadinessVerdict {
  readonly ready: boolean;
  readonly blockers: readonly Blocker[];
  /**
   * Hedging support, separated from the blocker list because it is a
   * structural fact about the account rather than a permission: without it,
   * independent simultaneous M1 and M5 positions are impossible at all.
   */
  readonly hedgingSupported: boolean | null;
  readonly snapshotAgeMs: number | null;
}

export interface ReadinessInput {
  readonly snapshot: Mt5PermissionSnapshot | null;
  /** The DEMO account this application is configured to trade. */
  readonly expectedLoginId: string | null;
  /** Explicit server evaluation instant. */
  readonly nowMs: number;
}

/**
 * Evaluates every §8 check. Returns ALL blockers rather than the first,
 * because an operator provisioning a new terminal needs the whole list, not a
 * sequence of single problems discovered one restart at a time.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessVerdict {
  const { snapshot, expectedLoginId, nowMs } = input;
  const blockers: Blocker[] = [];

  if (snapshot === null) {
    return {
      ready: false,
      blockers: [
        {
          code: 'NO_SNAPSHOT',
          origin: 'COLLECTOR',
          detail:
            'No MT5 permission snapshot has been received from this application’s collector. Execution is ' +
            'blocked: arriving quotes are not evidence that trading is permitted.',
        },
      ],
      hedgingSupported: null,
      snapshotAgeMs: null,
    };
  }

  const ageMs = nowMs - snapshot.capturedAtMs;
  if (ageMs > PERMISSION_SNAPSHOT_MAX_AGE_MS) {
    blockers.push({
      code: 'SNAPSHOT_STALE',
      origin: 'COLLECTOR',
      detail:
        `The MT5 permission snapshot is ${Math.round(ageMs / 1000)}s old, beyond the ` +
        `${PERMISSION_SNAPSHOT_MAX_AGE_MS / 1000}s budget. Permissions can be changed at any moment, so a ` +
        'stale snapshot does not describe the terminal now and is treated as blocking.',
    });
  }

  // --- Account identity. Trading the wrong account is the worst outcome
  // available here, so this is checked before anything about permissions.
  if (snapshot.loginId === null) {
    blockers.push({
      code: 'ACCOUNT_IDENTITY_UNKNOWN',
      origin: 'COLLECTOR',
      detail: 'The collector did not report which account the terminal is logged into. Execution is blocked.',
    });
  } else if (expectedLoginId === null) {
    blockers.push({
      code: 'ACCOUNT_IDENTITY_UNKNOWN',
      origin: 'CONFIGURATION',
      detail:
        `No expected DEMO account is configured for this application, so the terminal’s reported account ` +
        `(${snapshot.loginId}) cannot be verified. Execution is blocked.`,
    });
  } else if (snapshot.loginId !== expectedLoginId) {
    blockers.push({
      code: 'ACCOUNT_IDENTITY_MISMATCH',
      origin: 'CONFIGURATION',
      detail:
        `The terminal is logged into account ${snapshot.loginId}, but this application is configured for ` +
        `${expectedLoginId}. Execution is blocked. Do NOT switch another deployment’s terminal to this ` +
        'account: this application requires its own terminal and its own DEMO account.',
    });
  }

  // --- DEMO only. There is no REAL path in this application at all.
  if (snapshot.tradeMode === null) {
    blockers.push({
      code: 'TRADE_MODE_UNKNOWN',
      origin: 'COLLECTOR',
      detail: 'The account trade mode could not be determined. Execution is blocked; DEMO must be positively verified.',
    });
  } else if (snapshot.tradeMode !== 'DEMO') {
    blockers.push({
      code: 'NOT_DEMO',
      origin: 'BROKER',
      detail:
        `The account reports trade mode ${snapshot.tradeMode}, not DEMO. Execution is blocked unconditionally — ` +
        'this application has no real-account path.',
    });
  }

  // --- Terminal-side permissions. An operator can fix all of these locally.
  pushTriState(blockers, snapshot.terminalConnected, {
    whenFalse: {
      code: 'TERMINAL_DISCONNECTED',
      origin: 'TERMINAL',
      detail: 'The terminal reports it is not connected to the trade server. Execution is blocked.',
    },
    whenNull: {
      code: 'TERMINAL_CONNECTION_UNKNOWN',
      origin: 'COLLECTOR',
      detail: 'Terminal connection state could not be read. Execution is blocked rather than assumed.',
    },
  });

  pushTriState(blockers, snapshot.terminalTradeAllowed, {
    whenFalse: {
      code: 'TERMINAL_TRADE_NOT_ALLOWED',
      origin: 'TERMINAL',
      detail:
        'Terminal `trade_allowed` is false — algorithmic trading is switched off in the terminal itself. ' +
        'Execution is blocked. Enable it manually on THIS application’s terminal only.',
    },
    whenNull: {
      code: 'TERMINAL_TRADE_ALLOWED_UNKNOWN',
      origin: 'COLLECTOR',
      detail: 'Terminal `trade_allowed` could not be read. Execution is blocked rather than assumed.',
    },
  });

  // Inverted sense: `tradeapi_disabled = true` is the bad state.
  if (snapshot.terminalTradeApiDisabled === true) {
    blockers.push({
      code: 'TERMINAL_TRADE_API_DISABLED',
      origin: 'TERMINAL',
      detail:
        'Terminal `tradeapi_disabled` is true — the terminal is refusing API trade requests. Execution is blocked.',
    });
  } else if (snapshot.terminalTradeApiDisabled === null) {
    blockers.push({
      code: 'TERMINAL_TRADE_API_UNKNOWN',
      origin: 'COLLECTOR',
      detail: 'Terminal `tradeapi_disabled` could not be read. Execution is blocked rather than assumed.',
    });
  }

  // --- Broker-side permissions. Only the broker can change these.
  pushTriState(blockers, snapshot.accountTradeAllowed, {
    whenFalse: {
      code: 'ACCOUNT_TRADE_NOT_ALLOWED',
      origin: 'BROKER',
      detail:
        'Account `trade_allowed` is false — the broker has disabled trading on this account. Execution is ' +
        'blocked; this cannot be fixed from the terminal.',
    },
    whenNull: {
      code: 'ACCOUNT_TRADE_ALLOWED_UNKNOWN',
      origin: 'COLLECTOR',
      detail: 'Account `trade_allowed` could not be read. Execution is blocked rather than assumed.',
    },
  });

  pushTriState(blockers, snapshot.accountTradeExpert, {
    whenFalse: {
      code: 'ACCOUNT_TRADE_EXPERT_DISABLED',
      origin: 'BROKER',
      detail:
        'Account `trade_expert` is false — the broker has disabled expert-advisor trading on this account. ' +
        'Execution is blocked; this cannot be fixed from the terminal.',
    },
    whenNull: {
      code: 'ACCOUNT_TRADE_EXPERT_UNKNOWN',
      origin: 'COLLECTOR',
      detail: 'Account `trade_expert` could not be read. Execution is blocked rather than assumed.',
    },
  });

  // --- Hedging. Structural, not a permission (§4).
  const hedgingSupported = snapshot.marginMode === null ? null : snapshot.marginMode === 'RETAIL_HEDGING';
  if (snapshot.marginMode === null) {
    blockers.push({
      code: 'HEDGING_UNKNOWN',
      origin: 'COLLECTOR',
      detail:
        'The account margin mode could not be determined, so hedging support is unknown. Execution is blocked: ' +
        `this strategy may hold an M1 and an M5 ${V2_SYMBOL} position simultaneously, which netting cannot ` +
        'represent as two independent positions.',
    });
  } else if (snapshot.marginMode !== 'RETAIL_HEDGING') {
    blockers.push({
      code: 'HEDGING_UNSUPPORTED',
      origin: 'BROKER',
      detail:
        `The account margin mode is ${snapshot.marginMode}, not RETAIL_HEDGING. Execution is blocked. This ` +
        'strategy requires independent simultaneous M1 and M5 positions; under netting the broker would merge ' +
        'them into one net position, and this application will not silently emulate different semantics. A ' +
        'hedging account is required.',
    });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    hedgingSupported,
    snapshotAgeMs: ageMs,
  };
}

function pushTriState(
  blockers: Blocker[],
  value: boolean | null,
  cases: { whenFalse: Blocker; whenNull: Blocker },
): void {
  if (value === false) blockers.push(cases.whenFalse);
  else if (value === null) blockers.push(cases.whenNull);
}

/** One-line dashboard summary (§12). Never claims readiness from quotes. */
export function describeReadiness(verdict: ReadinessVerdict): string {
  if (verdict.ready) {
    return 'MT5 execution permissions verified: DEMO account confirmed, terminal and account both permit trading, hedging supported.';
  }
  const byOrigin = new Map<string, number>();
  for (const b of verdict.blockers) byOrigin.set(b.origin, (byOrigin.get(b.origin) ?? 0) + 1);
  const breakdown = [...byOrigin.entries()].map(([origin, n]) => `${n} ${origin.toLowerCase()}`).join(', ');
  return `Execution blocked by ${verdict.blockers.length} check(s) (${breakdown}): ${verdict.blockers
    .map((b) => b.code)
    .join(', ')}.`;
}
