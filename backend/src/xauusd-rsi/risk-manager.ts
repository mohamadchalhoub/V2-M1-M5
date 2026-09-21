/**
 * The independent, deterministic risk gate for
 * `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Pure: every input is passed in, nothing is read from a database, a clock
 * or the environment, so every rejection path is directly testable.
 *
 * Deliberately re-checks things the coordinator has already checked. That
 * duplication is the point — this is the last deterministic gate before a
 * decision is allowed to become a queued order, and it must not depend on
 * an earlier layer having done its job.
 *
 * It NEVER adjusts an order to make it acceptable. Every failure is a
 * rejection: volume is never resized, the $5 bracket is never widened to
 * satisfy a broker stops level, and risk is never sized down to fit a cap.
 * Spec §10 is explicit about this, and silently "fixing" an order would
 * mean executing something the rules never described.
 */
import {
  RSI_COMBINED_RISK_CAP_PCT,
  RSI_DAILY_LOSS_CAP_PCT,
  RSI_DRAWDOWN_CAP_PCT,
  RSI_SL_POINTS,
  RSI_SL_TP_TOLERANCE_POINTS,
  RSI_STOP_RISK_CAP_PCT,
  RSI_TP_POINTS,
} from './safety-constants';

/** Mirrors MT5's own ACCOUNT_TRADE_MODE_* enum — a closed set, not a boolean. */
export type RsiAccountTradeMode = 'DEMO' | 'REAL' | 'CONTEST';

/**
 * Mirrors MT5's ACCOUNT_MARGIN_MODE_*, plus an explicit UNKNOWN.
 *
 * UNKNOWN is kept distinct from RETAIL_NETTING on purpose. Both block a
 * second concurrent position, but only one of them is an assertion about the
 * broker, and the rejection text says which.
 */
export type RsiAccountMarginMode = 'RETAIL_NETTING' | 'EXCHANGE' | 'RETAIL_HEDGING' | 'UNKNOWN';

export interface RsiCandidateOrder {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Gold points, not dollars. */
  stopLossDistancePoints: number;
  takeProfitDistancePoints: number;
}

export interface RsiBrokerConstraints {
  minLots: number;
  maxLots: number;
  stepLots: number;
  /**
   * Minimum distance, in points, the broker allows between the market price
   * and a stop/limit level (MT5 `SYMBOL_TRADE_STOPS_LEVEL`). A $5 stop that
   * violates this is REJECTED, never widened.
   */
  stopsLevelPoints: number | null;
  /** MT5 `SYMBOL_TRADE_FREEZE_LEVEL` — distance within which modify/close is refused. */
  freezeLevelPoints: number | null;
  /**
   * The broker's minimum meaningful price movement. Bracket prices must be a
   * whole multiple of it, or the broker will round them and the resulting
   * position would not carry the distance the rules specify.
   */
  tickSize: number | null;
}

export interface RsiOccupancyState {
  /**
   * True when THIS family's slot is unavailable.
   *
   * Two distinct situations set it, and the description says which:
   *
   *   1. This family already holds a position or an in-flight submission.
   *      Note the other family holding one does NOT set this — that is the
   *      whole point of the two-slot model.
   *   2. XAUUSD exposure exists that cannot be attributed to a slot at all:
   *      a foreign or manual position, or an unresolved submission from a
   *      retired strategy. That protection is deliberately retained.
   */
  hasExistingXauusdExposure: boolean;
  exposureDescription: string | null;
}

export interface RsiAccountRiskInfo {
  tradeMode: RsiAccountTradeMode;
  /** How the broker accounts for positions — see `RsiAccountMarginMode`. */
  marginMode: RsiAccountMarginMode;
  /** Live-queried equity in the ACCOUNT's own currency — never assumed. */
  equity: number;
  accountCurrency: string;
  /** Gold's profit currency from live symbol metadata (typically USD). */
  profitCurrency: string;
  /** Multiplier from profit currency to account currency. Null when unavailable. */
  profitCurrencyToAccountCurrencyRate: number | null;
  /** Contract size (ounces per lot) from live symbol metadata. */
  contractSize: number | null;
  existingCombinedRiskAmount: number;
  todaysLossAmount: number;
  currentDrawdownPct: number;
}

export interface RsiRiskManagerInput {
  candidate: RsiCandidateOrder;
  accountInfo: RsiAccountRiskInfo;
  occupancy: RsiOccupancyState;
  constraints: RsiBrokerConstraints;
  killSwitchActive: boolean;
  entriesBlockedReason: string | null;
  entryDeviationPoints: number;
  maxEntryDeviationPoints: number;
  requestedVolumeLots: number;
  pointSize: number;
  /**
   * True when the OTHER rule family already holds a position or an in-flight
   * submission, so accepting this candidate would mean two concurrent
   * positions on one symbol.
   *
   * That is only faithfully possible on a hedging account; see the check in
   * `evaluateRsiRiskManager`.
   */
  otherFamilySlotHeld: boolean;
}

export interface RsiRiskManagerVerdict {
  approved: boolean;
  rejectionReason: string | null;
  volumeLots: number | null;
  /** Estimated stop risk in account currency, recorded on the decision for audit. */
  stopRiskAmount: number | null;
  stopRiskPct: number | null;
}

const reject = (rejectionReason: string): RsiRiskManagerVerdict => ({
  approved: false,
  rejectionReason,
  volumeLots: null,
  stopRiskAmount: null,
  stopRiskPct: null,
});

export function evaluateRsiRiskManager(input: RsiRiskManagerInput): RsiRiskManagerVerdict {
  const {
    candidate,
    accountInfo,
    occupancy,
    constraints,
    killSwitchActive,
    entriesBlockedReason,
    entryDeviationPoints,
    maxEntryDeviationPoints,
    requestedVolumeLots,
    pointSize,
  } = input;

  if (killSwitchActive) {
    return reject('Kill switch is active — no new XAUUSD orders permitted.');
  }
  if (entriesBlockedReason) {
    return reject(`New entries are blocked: ${entriesBlockedReason}`);
  }

  // The single most safety-critical check.
  if (accountInfo.tradeMode !== 'DEMO') {
    return reject(
      `Refusing to trade: account trade_mode is "${accountInfo.tradeMode}", not DEMO. This is an absolute, non-negotiable safety rule.`,
    );
  }

  // Two concurrent positions on one symbol, each with its own stop and
  // target, only exist on a HEDGING account. On a netting account a second
  // order merges with, reduces or reverses the first — so the second slot
  // would not be what the rules describe, and the honest response is to
  // refuse it rather than emulate it with one net position.
  if (input.otherFamilySlotHeld && accountInfo.marginMode !== 'RETAIL_HEDGING') {
    return reject(
      accountInfo.marginMode === 'UNKNOWN'
        ? 'The other rule family already holds a position, and the broker\'s margin mode could not be established. Refusing a second concurrent position rather than assuming the account supports independent positions.'
        : `The other rule family already holds a position, and this account's margin mode is ${accountInfo.marginMode}, not RETAIL_HEDGING. A second order would merge with, reduce or reverse the existing position instead of opening an independent one, so it is refused rather than emulated.`,
    );
  }

  if (occupancy.hasExistingXauusdExposure) {
    return reject(
      `Refusing to open a new XAUUSD order — ${occupancy.exposureDescription ?? "this family's slot is unavailable"}.`,
    );
  }

  if (entryDeviationPoints > maxEntryDeviationPoints) {
    return reject(
      `Executable price has moved ${entryDeviationPoints.toFixed(1)}pt since the signal, beyond the ${maxEntryDeviationPoints}pt limit — skipping, not chasing.`,
    );
  }

  // --- Volume: validated against real broker limits, never resized. ---
  const volume = requestedVolumeLots;
  if (!Number.isFinite(volume) || volume <= 0) {
    return reject(`Requested volume ${volume} is not a valid positive number — refusing before any risk calculation.`);
  }
  if (volume < constraints.minLots || volume > constraints.maxLots) {
    return reject(
      `Requested volume ${volume} lots is outside the broker's bounds [${constraints.minLots}, ${constraints.maxLots}] — skipping, never auto-resizing.`,
    );
  }
  const stepRemainder = Math.abs(volume / constraints.stepLots - Math.round(volume / constraints.stepLots));
  if (stepRemainder > 1e-6) {
    return reject(
      `Requested volume ${volume} lots is not a multiple of the broker's step ${constraints.stepLots} — skipping, never auto-resizing.`,
    );
  }

  // --- Brackets: exactly $5 each, on the correct side, broker-legal. ---
  if (Math.abs(candidate.stopLossDistancePoints - RSI_SL_POINTS) > RSI_SL_TP_TOLERANCE_POINTS) {
    return reject(
      `Stop-loss distance ${candidate.stopLossDistancePoints.toFixed(1)}pt does not match the required ${RSI_SL_POINTS}pt ($5).`,
    );
  }
  if (Math.abs(candidate.takeProfitDistancePoints - RSI_TP_POINTS) > RSI_SL_TP_TOLERANCE_POINTS) {
    return reject(
      `Take-profit distance ${candidate.takeProfitDistancePoints.toFixed(1)}pt does not match the required ${RSI_TP_POINTS}pt ($5).`,
    );
  }
  if (candidate.action === 'OPEN_BUY' && !(candidate.stopLoss < candidate.entryPrice && candidate.takeProfit > candidate.entryPrice)) {
    return reject('OPEN_BUY stop-loss/take-profit are on the wrong side of entry.');
  }
  if (candidate.action === 'OPEN_SELL' && !(candidate.stopLoss > candidate.entryPrice && candidate.takeProfit < candidate.entryPrice)) {
    return reject('OPEN_SELL stop-loss/take-profit are on the wrong side of entry.');
  }

  // Broker stops level: the $5 distance must already satisfy it. If it does
  // not, the order is refused — widening the stop would execute a trade the
  // user's rules never described.
  if (constraints.stopsLevelPoints === null) {
    return reject(
      "Broker stops level is unknown (no fresh symbol metadata) — refusing rather than assuming the $5 bracket is acceptable.",
    );
  }
  if (constraints.stopsLevelPoints > 0 && RSI_SL_POINTS < constraints.stopsLevelPoints) {
    return reject(
      `The required $5 stop (${RSI_SL_POINTS}pt) is inside the broker's minimum stops level of ${constraints.stopsLevelPoints}pt. Refusing — the stop is never widened to make an order acceptable.`,
    );
  }
  if (constraints.stopsLevelPoints > 0 && RSI_TP_POINTS < constraints.stopsLevelPoints) {
    return reject(
      `The required $5 take-profit (${RSI_TP_POINTS}pt) is inside the broker's minimum stops level of ${constraints.stopsLevelPoints}pt. Refusing rather than altering the target.`,
    );
  }

  // Tick size: a bracket the broker would round is not the bracket the rules
  // specify, so it is rejected rather than quietly accepted.
  if (constraints.tickSize !== null && constraints.tickSize > 0) {
    for (const [label, price] of [
      ['stop-loss', candidate.stopLoss],
      ['take-profit', candidate.takeProfit],
    ] as const) {
      const ticks = price / constraints.tickSize;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-6) {
        return reject(
          `Computed ${label} ${price} is not a whole multiple of the broker's tick size ${constraints.tickSize} — refusing rather than letting the broker round the protective distance.`,
        );
      }
    }
  }

  // --- Equity-based caps, against real queried equity. ---
  if (accountInfo.equity <= 0) {
    return reject('Refusing to size risk against non-positive or unavailable account equity.');
  }

  const needsConversion = accountInfo.profitCurrency !== accountInfo.accountCurrency;
  if (needsConversion && (accountInfo.profitCurrencyToAccountCurrencyRate === null || accountInfo.profitCurrencyToAccountCurrencyRate <= 0)) {
    return reject(
      `Refusing to size risk: gold's profit currency (${accountInfo.profitCurrency}) differs from the account currency (${accountInfo.accountCurrency}) and no live conversion rate is available — never assuming 1:1.`,
    );
  }
  const conversionRate = needsConversion ? (accountInfo.profitCurrencyToAccountCurrencyRate as number) : 1;

  if (accountInfo.contractSize === null || !(accountInfo.contractSize > 0)) {
    return reject('Refusing to size risk: gold contract size is unavailable from live symbol metadata — never assumed.');
  }

  // Stop risk = price distance x ounces per lot x lots, converted to account
  // currency. Uses the real contract size rather than the previous strategy's
  // points-times-lots approximation, so the cap is enforced against the
  // amount actually at risk.
  const stopDistancePrice = candidate.stopLossDistancePoints * pointSize;
  const stopRiskAmount = stopDistancePrice * accountInfo.contractSize * volume * conversionRate;
  const stopRiskPct = (stopRiskAmount / accountInfo.equity) * 100;

  if (stopRiskPct > RSI_STOP_RISK_CAP_PCT) {
    return reject(
      `Estimated stop risk ${stopRiskPct.toFixed(3)}% of equity (${stopRiskAmount.toFixed(2)} ${accountInfo.accountCurrency}) exceeds the ${RSI_STOP_RISK_CAP_PCT}% per-trade cap — skipping. Volume is never reduced to fit.`,
    );
  }
  const combinedRiskPct = ((accountInfo.existingCombinedRiskAmount + stopRiskAmount) / accountInfo.equity) * 100;
  if (combinedRiskPct > RSI_COMBINED_RISK_CAP_PCT) {
    return reject(`Combined open risk ${combinedRiskPct.toFixed(3)}% of equity would exceed the ${RSI_COMBINED_RISK_CAP_PCT}% combined cap.`);
  }
  const dailyLossPct = (accountInfo.todaysLossAmount / accountInfo.equity) * 100;
  if (dailyLossPct >= RSI_DAILY_LOSS_CAP_PCT) {
    return reject(
      `Today's realized+floating loss ${dailyLossPct.toFixed(3)}% of equity has reached the ${RSI_DAILY_LOSS_CAP_PCT}% daily cap — no new entries today.`,
    );
  }
  if (accountInfo.currentDrawdownPct >= RSI_DRAWDOWN_CAP_PCT) {
    return reject(`Current drawdown ${accountInfo.currentDrawdownPct.toFixed(3)}% has reached the ${RSI_DRAWDOWN_CAP_PCT}% cap — no new entries.`);
  }

  return { approved: true, rejectionReason: null, volumeLots: volume, stopRiskAmount, stopRiskPct };
}

/**
 * Builds the $5/$5 bracket for a candidate entry.
 *
 * Prices are rounded to the instrument's own digit precision (2 for XAUUSD),
 * NOT adjusted for distance — the distance stays exactly $5 and the risk gate
 * above re-verifies that it did.
 */
export function buildRsiBracket(action: 'OPEN_BUY' | 'OPEN_SELL', entryPrice: number, tpUsd: number, slUsd: number): { stopLoss: number; takeProfit: number } {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  if (action === 'OPEN_BUY') {
    return { stopLoss: round2(entryPrice - slUsd), takeProfit: round2(entryPrice + tpUsd) };
  }
  return { stopLoss: round2(entryPrice + slUsd), takeProfit: round2(entryPrice - tpUsd) };
}
