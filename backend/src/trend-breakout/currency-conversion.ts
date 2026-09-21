/**
 * §10 — "Calculate monetary risk using broker contract data and account-
 * currency conversion." Both this project's demo accounts trade EUR-
 * denominated (see .env's `BOOTSTRAP_MT5_CURRENCY=EUR`), while EURUSD and
 * XAUUSD both profit/loss in USD on a standard MT5 contract spec
 * (`SymbolMetadata.profitCurrency`) — so converting a USD stop-risk amount
 * into the account's EUR requires a EUR/USD rate. This project already has
 * a real, live EURUSD price feed (the exact instrument being traded) — this
 * module reuses THAT rate for the conversion rather than adding a second,
 * independent FX-rate source, and documents the approximation involved
 * (mid-price, not bid/ask-specific) plainly rather than presenting it as
 * more precise than it is.
 */

export interface ConversionInput {
  /** The instrument's own profit currency, e.g. "USD" (from SymbolMetadata). */
  profitCurrency: string;
  /** The account's currency, e.g. "EUR" (TradingAccount.currency). */
  accountCurrency: string;
  /** A current EURUSD mid price — the only cross-rate this system has a live feed for. Required only when profitCurrency !== accountCurrency and neither IS EUR/USD directly. */
  eurUsdMid: number | null;
}

/**
 * Returns the multiplier to convert an amount in `profitCurrency` into
 * `accountCurrency`, or `null` when it cannot be determined (fails closed —
 * callers must block the entry, never assume 1:1). Only two real currencies
 * are in scope for this project today (EUR account, USD-profit
 * instruments), so this is deliberately narrow rather than a general FX
 * conversion table: it explicitly refuses to convert between any OTHER
 * currency pair rather than silently returning an unsupported rate.
 */
export function resolveConversionRate(input: ConversionInput): number | null {
  const { profitCurrency, accountCurrency, eurUsdMid } = input;
  if (profitCurrency === accountCurrency) return 1;

  if (profitCurrency === 'USD' && accountCurrency === 'EUR') {
    if (eurUsdMid === null || !(eurUsdMid > 0)) return null;
    return 1 / eurUsdMid; // 1 USD = (1 / EURUSD) EUR
  }
  if (profitCurrency === 'EUR' && accountCurrency === 'USD') {
    if (eurUsdMid === null || !(eurUsdMid > 0)) return null;
    return eurUsdMid; // 1 EUR = EURUSD USD
  }

  // Any other combination is genuinely unsupported by this project's single
  // EURUSD rate feed — fail closed rather than guess.
  return null;
}
