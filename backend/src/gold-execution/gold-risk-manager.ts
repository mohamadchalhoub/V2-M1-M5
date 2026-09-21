import {
  GOLD_COMBINED_RISK_CAP_PCT,
  GOLD_DAILY_LOSS_CAP_PCT,
  GOLD_DRAWDOWN_CAP_PCT,
  GOLD_SL_TP_TOLERANCE_POINTS,
  GOLD_STOP_RISK_CAP_PCT,
  GOLD_TP_SL_POINTS,
} from './gold-safety-constants';

/** Same closed-set posture as autonomous/risk-manager.ts's AccountTradeMode — mirrors MT5's own enum, not a boolean. */
export type GoldAccountTradeMode = 'DEMO' | 'REAL' | 'CONTEST';

export interface GoldCandidateOrder {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Points, not dollars — same convention as the EURUSD risk manager. */
  stopLossDistancePoints: number;
  takeProfitDistancePoints: number;
}

export interface GoldBrokerVolumeConstraints {
  minLots: number;
  maxLots: number;
  stepLots: number;
}

export interface GoldOccupancyState {
  /**
   * True if ANY XAUUSD exposure already exists — manual positions, this or
   * any other strategy's magic number, pending orders, or an UNKNOWN
   * (unreconciled) submission. Friend rule: "one at a time" is enforced
   * across ALL of these, not just this strategy's own magic number.
   */
  hasExistingXauusdExposure: boolean;
  exposureDescription: string | null;
}

export interface GoldAccountRiskInfo {
  tradeMode: GoldAccountTradeMode;
  /** Real, live-queried equity, in the ACCOUNT's own currency — never an assumed balance. */
  equity: number;
  /** The account's own currency (e.g. 'EUR') — read live from TradingAccount.currency, never assumed. */
  accountCurrency: string;
  /**
   * Gold's own profit currency (from live SymbolMetadata, e.g. 'USD') and a
   * live conversion rate FROM that profit currency TO the account currency
   * (i.e. multiply a profit-currency amount by this to get account-currency
   * amount). Required whenever profitCurrency !== accountCurrency — the
   * risk gate fails closed (rejects) rather than assume 1:1 if a
   * conversion is needed but this is null/unavailable, since XAUUSD's P&L
   * is USD-denominated while this account's equity is EUR-denominated and
   * silently treating $1 as €1 would understate risk by the EURUSD rate.
   */
  profitCurrency: string;
  profitCurrencyToAccountCurrencyRate: number | null;
  /** Sum of stop-risk of any other currently-open combined-risk-counted positions, in ACCOUNT currency. */
  existingCombinedRiskAmount: number;
  /** Realized+floating loss so far today, in ACCOUNT currency (positive number = loss). */
  todaysLossAmount: number;
  /** Peak-to-current drawdown percentage already incurred, independent of this candidate. */
  currentDrawdownPct: number;
}

export interface GoldRiskManagerInput {
  candidate: GoldCandidateOrder;
  accountInfo: GoldAccountRiskInfo;
  occupancy: GoldOccupancyState;
  volumeConstraints: GoldBrokerVolumeConstraints;
  killSwitchActive: boolean;
  /** Signal-time executable price vs. current executable price, both already point-distance in gold points. */
  entryDeviationPoints: number;
  maxEntryDeviationPoints: number;
  /**
   * The ONE validated user volume snapshot for this evaluation (from
   * `GoldRuntimeSettingsService.getVolumeLots()`, read exactly once by the
   * caller and passed in here — never re-read mid-evaluation, so risk
   * calculation, the persisted decision, and the eventual broker submission
   * all use the identical number). Replaces the formerly-hardcoded
   * `GOLD_VOLUME_LOTS` constant; the risk CAPS themselves (stop-risk %,
   * combined %, daily loss %, drawdown %) and the SL/TP distance logic
   * below are completely unchanged — only the volume input to those caps
   * is now a live, user-set value instead of a frozen literal.
   */
  requestedVolumeLots: number;
}

export interface GoldRiskManagerVerdict {
  approved: boolean;
  rejectionReason: string | null;
  volumeLots: number | null;
}

/**
 * Gold's independent, deterministic risk gate — analogous to
 * `autonomous/risk-manager.ts`'s `evaluateRiskManager`, but for the
 * mechanical confirmed-retest-v2-derived gold strategy instead of an
 * AI-assisted EURUSD decision. Deliberately re-checks everything a
 * coordinator might already have checked (defense in depth, same posture
 * as the EURUSD risk manager's own header comment).
 */
export function evaluateGoldRiskManager(input: GoldRiskManagerInput): GoldRiskManagerVerdict {
  const { candidate, accountInfo, occupancy, volumeConstraints, killSwitchActive, entryDeviationPoints, maxEntryDeviationPoints, requestedVolumeLots } = input;

  if (killSwitchActive) {
    return { approved: false, rejectionReason: 'Kill switch is active — no new gold orders permitted.', volumeLots: null };
  }

  // The single most safety-critical check: never trade a real-money account.
  if (accountInfo.tradeMode !== 'DEMO') {
    return {
      approved: false,
      rejectionReason: `Refusing to trade gold: account trade_mode is "${accountInfo.tradeMode}", not DEMO. This is an absolute, non-negotiable safety rule.`,
      volumeLots: null,
    };
  }

  if (occupancy.hasExistingXauusdExposure) {
    return {
      approved: false,
      rejectionReason: `Refusing to open a new XAUUSD order — existing exposure already occupies the one-position slot (${occupancy.exposureDescription ?? 'unspecified'}).`,
      volumeLots: null,
    };
  }

  if (entryDeviationPoints > maxEntryDeviationPoints) {
    return {
      approved: false,
      rejectionReason: `Executable price has moved ${entryDeviationPoints.toFixed(1)}pt since signal, beyond the max entry deviation of ${maxEntryDeviationPoints}pt — skipping, not chasing.`,
      volumeLots: null,
    };
  }

  // Volume: user-set (via the dashboard, GoldRuntimeSettingsService), validated
  // against real broker step/min/max, and rejected outright before reaching
  // any risk-cap math if it isn't even a positive finite number — never
  // resized, never silently substituted.
  const volume = requestedVolumeLots;
  if (!Number.isFinite(volume) || volume <= 0) {
    return {
      approved: false,
      rejectionReason: `Requested volume ${volume} is not a valid positive number — refusing before any risk calculation.`,
      volumeLots: null,
    };
  }
  if (volume < volumeConstraints.minLots || volume > volumeConstraints.maxLots) {
    return {
      approved: false,
      rejectionReason: `Requested volume ${volume} lots is outside broker bounds [${volumeConstraints.minLots}, ${volumeConstraints.maxLots}] — skipping, never auto-resizing.`,
      volumeLots: null,
    };
  }
  const stepRemainder = Math.abs(volume / volumeConstraints.stepLots - Math.round(volume / volumeConstraints.stepLots));
  if (stepRemainder > 1e-6) {
    return {
      approved: false,
      rejectionReason: `Requested volume ${volume} lots is not a multiple of the broker's step ${volumeConstraints.stepLots} — skipping, never auto-resizing.`,
      volumeLots: null,
    };
  }

  if (Math.abs(candidate.stopLossDistancePoints - GOLD_TP_SL_POINTS) > GOLD_SL_TP_TOLERANCE_POINTS) {
    return {
      approved: false,
      rejectionReason: `Stop-loss distance ${candidate.stopLossDistancePoints.toFixed(1)}pt does not match the required ${GOLD_TP_SL_POINTS}pt ($10).`,
      volumeLots: null,
    };
  }
  if (Math.abs(candidate.takeProfitDistancePoints - GOLD_TP_SL_POINTS) > GOLD_SL_TP_TOLERANCE_POINTS) {
    return {
      approved: false,
      rejectionReason: `Take-profit distance ${candidate.takeProfitDistancePoints.toFixed(1)}pt does not match the required ${GOLD_TP_SL_POINTS}pt ($10).`,
      volumeLots: null,
    };
  }

  if (candidate.action === 'OPEN_BUY' && !(candidate.stopLoss < candidate.entryPrice && candidate.takeProfit > candidate.entryPrice)) {
    return { approved: false, rejectionReason: 'OPEN_BUY stop-loss/take-profit are on the wrong side of entry.', volumeLots: null };
  }
  if (candidate.action === 'OPEN_SELL' && !(candidate.stopLoss > candidate.entryPrice && candidate.takeProfit < candidate.entryPrice)) {
    return { approved: false, rejectionReason: 'OPEN_SELL stop-loss/take-profit are on the wrong side of entry.', volumeLots: null };
  }

  // Equity-based risk caps — real equity, never assumed.
  if (accountInfo.equity <= 0) {
    return { approved: false, rejectionReason: 'Refusing to size risk against non-positive or unavailable account equity.', volumeLots: null };
  }

  // Currency conversion — XAUUSD's P&L is denominated in gold's own
  // profit currency (from live SymbolMetadata, typically USD), while this
  // account's equity is in its own currency (this deployment: EUR). Never
  // assume 1:1: fail closed if a conversion is actually needed but no live
  // rate is available, since silently treating $1 as €1 (a ~13-15%
  // understatement at typical EURUSD rates) would let a trade through that
  // actually exceeds the intended risk cap.
  const needsConversion = accountInfo.profitCurrency !== accountInfo.accountCurrency;
  if (needsConversion && (accountInfo.profitCurrencyToAccountCurrencyRate === null || accountInfo.profitCurrencyToAccountCurrencyRate <= 0)) {
    return {
      approved: false,
      rejectionReason: `Refusing to size risk: gold's profit currency (${accountInfo.profitCurrency}) differs from the account currency (${accountInfo.accountCurrency}) and no live conversion rate is available — never assuming 1:1.`,
      volumeLots: null,
    };
  }
  const conversionRate = needsConversion ? (accountInfo.profitCurrencyToAccountCurrencyRate as number) : 1;

  const stopRiskAmount = volume * candidate.stopLossDistancePoints * conversionRate; // approximate $/point-to-lot scaling; exact contract-size-based value is handled by caller if more precision is needed
  const stopRiskPct = (stopRiskAmount / accountInfo.equity) * 100;
  if (stopRiskPct > GOLD_STOP_RISK_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Estimated stop risk ${stopRiskPct.toFixed(3)}% of equity exceeds the ${GOLD_STOP_RISK_CAP_PCT}% per-trade cap — skipping (fixed volume is not reduced).`,
      volumeLots: null,
    };
  }
  const combinedRiskPct = ((accountInfo.existingCombinedRiskAmount + stopRiskAmount) / accountInfo.equity) * 100;
  if (combinedRiskPct > GOLD_COMBINED_RISK_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Combined open risk ${combinedRiskPct.toFixed(3)}% of equity would exceed the ${GOLD_COMBINED_RISK_CAP_PCT}% combined cap.`,
      volumeLots: null,
    };
  }
  const dailyLossPct = (accountInfo.todaysLossAmount / accountInfo.equity) * 100;
  if (dailyLossPct >= GOLD_DAILY_LOSS_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Today's realized+floating loss ${dailyLossPct.toFixed(3)}% of equity has already reached the ${GOLD_DAILY_LOSS_CAP_PCT}% daily loss cap — no new entries today.`,
      volumeLots: null,
    };
  }
  if (accountInfo.currentDrawdownPct >= GOLD_DRAWDOWN_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Current drawdown ${accountInfo.currentDrawdownPct.toFixed(3)}% has already reached the ${GOLD_DRAWDOWN_CAP_PCT}% cap — no new entries.`,
      volumeLots: null,
    };
  }

  return { approved: true, rejectionReason: null, volumeLots: volume };
}
