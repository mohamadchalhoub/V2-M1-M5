/**
 * §2 — every earlier entry route is disabled **in this copy only**.
 *
 * This application must have exactly one enabled strategy version, with two
 * execution paths (M1 and M5). Everything that could previously generate or
 * submit an entry is therefore switched off here, at the single point each
 * of those strategies consults before acting.
 *
 * ## Why this, rather than deleting the code
 *
 * The retired strategies' modules, tables and historical rows stay in place
 * and stay interpretable. §2 asks for their *active entry wiring* to be
 * removed or disabled, not for their history to be destroyed, and §1 forbids
 * deleting trading history or audit records anywhere. Cutting the entry path
 * at the mode gate achieves the required behaviour while leaving every past
 * decision readable exactly as it was recorded.
 *
 * ## Why a hard-coded constant rather than an environment default
 *
 * Each of those strategies already defaulted its mode to `OFF` and "failed
 * closed" on a typo. That is not sufficient here. A default is something an
 * operator can change, and in this project changing it would start a second,
 * unrelated strategy trading on the same DEMO account as the M1/M5 paths —
 * competing for the same margin, and opening positions this application's
 * ownership registry deliberately does not recognise.
 *
 * So the gate is closed in code. `XAUUSD_RSI_EXECUTION_MODE=DEMO` in this
 * project's `.env` has no effect: the getter returns `OFF` regardless. The
 * only way to re-enable one of these strategies is to edit its source, which
 * is exactly the level of deliberation that decision warrants.
 *
 * ## What is NOT disabled
 *
 * Protective management, reconciliation, Friday liquidation of anything a
 * retired strategy may still own, dashboards, health checks and history
 * remain fully functional. Disabling entry generation is not the same as
 * abandoning an open position, and §7 requires pauses and kill switches to
 * block new entries "without disabling required reconciliation or protective
 * management". In practice this project's database starts clean, so none of
 * those strategies has an open position here at all.
 *
 * ## The other application is unaffected
 *
 * This file exists only in this copy. The M1 revision-5 bot running from its
 * own checkout, on its own account, keeps its own entry wiring enabled and is
 * in no way altered by anything here.
 */
import { XAUUSD_M1M5_STRATEGY_VERSION } from './spec';

/**
 * The single reason string reported wherever a legacy strategy explains why
 * it is not trading, so the dashboard and logs say the same thing.
 */
export const LEGACY_ENTRIES_DISABLED_REASON =
  `Entry generation is disabled in this application. ${XAUUSD_M1M5_STRATEGY_VERSION} is the only enabled ` +
  'strategy here, and it owns the M1 and M5 execution paths. This strategy’s code, tables and historical ' +
  'records are retained and readable; only its ability to generate or submit an entry has been removed.';

/**
 * Strategies whose entry wiring is disabled in this copy, for the startup
 * log line and the dashboard's "old entry paths disabled" confirmation
 * (§14).
 */
export const DISABLED_LEGACY_ENTRY_PATHS: readonly string[] = [
  'H4 support/resistance first-touch (legacy EURUSD autonomous rule engine)',
  'XAUUSD H4 confirmed-retest gold',
  'XAUUSD M1 RSI peak/trough retest (xauusd-m1-rsi-retest-extremes-v1)',
  'XAUUSD M1 RSI standalone Extreme SELL/BUY',
  'H4-trend / H1-breakout (EURUSD and XAUUSD)',
  'AI-assisted trading approval or veto',
];

/**
 * Hard OFF. Every legacy execution-mode getter returns this rather than
 * reading its environment variable.
 */
export const LEGACY_EXECUTION_MODE = 'OFF' as const;
