// Pure helper for HIGH_IMPACT_EVENT_EXPOSURE — a standard 6-letter FX pair
// symbol (EURUSD, GBPJPY, ...) is two 3-letter ISO 4217 currency codes back
// to back; brokers commonly append a suffix (EURUSD.a, EURUSDm, EURUSD#) —
// only the leading 6 letters are read, everything after is ignored. Returns
// null for anything that isn't shaped like a currency pair (XAUUSD is
// deliberately treated as one here — gold against USD is a real currency
// exposure; a pure equity/index symbol like "US30" or "NAS100" correctly
// returns null since it has no letter run to parse as two codes).
export function parseForexSymbolCurrencies(symbol: string): [string, string] | null {
  const match = /^([A-Za-z]{3})([A-Za-z]{3})/.exec(symbol);
  if (!match) return null;
  return [match[1].toUpperCase(), match[2].toUpperCase()];
}
