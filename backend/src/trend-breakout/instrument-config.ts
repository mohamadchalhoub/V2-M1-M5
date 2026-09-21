import { ConfigService } from '@nestjs/config';

/**
 * §2 — "Allowed instruments: EURUSD. Gold against USD, normally XAUUSD,
 * mapped to the connected broker's actual symbol." This is the CANONICAL,
 * internal instrument identity — never necessarily the broker's own literal
 * symbol string (a broker may spell gold "XAUUSD.a", "GOLD", "XAUUSDm",
 * etc). Matches the Prisma `TrendBreakoutInstrument` enum exactly.
 */
export const TREND_BREAKOUT_INSTRUMENTS = ['EURUSD', 'XAUUSD'] as const;
export type TrendBreakoutInstrumentId = (typeof TREND_BREAKOUT_INSTRUMENTS)[number];

export interface InstrumentMapping {
  instrument: TrendBreakoutInstrumentId;
  /** The broker's actual symbol string for this instrument, as configured. */
  brokerSymbol: string;
  /** User-controlled default volume (lots) per §2 — overridden by TrendBreakoutVolumeSetting once one exists in the database; this is only the bootstrap default. */
  defaultVolumeLots: number;
}

export class AmbiguousSymbolMappingError extends Error {}

// A closed list of ISO-4217-shaped currency codes this project ever expects
// to see embedded in a gold symbol string, used only to DETECT a foreign
// currency accidentally present in a configured gold mapping (e.g.
// "XAUEUR", "XAUGBP") — not an exhaustive currency list, just enough
// coverage to catch the crosses a broker's gold symbol set commonly offers,
// per §2's "reject ambiguous mappings; do not accidentally allow gold
// crosses." USD is deliberately excluded from this list — its presence is
// REQUIRED, not forbidden.
const NON_USD_CURRENCY_CODES = ['EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'JPY', 'CNH', 'CNY', 'SGD', 'TRY', 'ZAR', 'MXN'];

/**
 * Validates one instrument's configured broker symbol is unambiguous —
 * "explicit broker-symbol mapping. Reject ambiguous mappings; do not
 * accidentally allow gold crosses or unrelated contracts" (§2). Deliberately
 * conservative: rejects anything it cannot positively confirm, rather than
 * trying to be permissive about broker suffix conventions it hasn't been
 * told about.
 */
export function assertUnambiguousSymbol(instrument: TrendBreakoutInstrumentId, brokerSymbol: string): void {
  const symbol = brokerSymbol.trim();
  if (!symbol) {
    throw new AmbiguousSymbolMappingError(`${instrument}: broker symbol is empty.`);
  }
  const upper = symbol.toUpperCase();

  if (instrument === 'EURUSD') {
    // Must start with EURUSD (allowing a broker suffix like "EURUSD.a",
    // "EURUSDm") and must not embed any OTHER currency pair inside that
    // suffix (a real broker suffix is short and alphanumeric/punctuation,
    // never itself a second currency code).
    if (!upper.startsWith('EURUSD')) {
      throw new AmbiguousSymbolMappingError(`EURUSD: configured broker symbol "${symbol}" does not start with "EURUSD" — refusing an unconfirmed mapping.`);
    }
    const suffix = upper.slice('EURUSD'.length);
    for (const code of NON_USD_CURRENCY_CODES) {
      if (suffix.includes(code)) {
        throw new AmbiguousSymbolMappingError(`EURUSD: configured broker symbol "${symbol}" has a suffix containing "${code}" — looks like a different pair, refusing.`);
      }
    }
    return;
  }

  // XAUUSD: must start with XAU, must contain USD, and must not contain any
  // OTHER currency code anywhere (catches "XAUEUR", "XAUGBP", and also a
  // pathological "XAUUSDEUR"-shaped string).
  if (!upper.startsWith('XAU')) {
    throw new AmbiguousSymbolMappingError(`XAUUSD: configured broker symbol "${symbol}" does not start with "XAU" — refusing an unconfirmed gold mapping.`);
  }
  if (!upper.includes('USD')) {
    throw new AmbiguousSymbolMappingError(`XAUUSD: configured broker symbol "${symbol}" does not contain "USD" — this system only trades gold against USD, refusing.`);
  }
  const remainder = upper.slice(3); // after "XAU"
  for (const code of NON_USD_CURRENCY_CODES) {
    if (remainder.includes(code)) {
      throw new AmbiguousSymbolMappingError(`XAUUSD: configured broker symbol "${symbol}" also contains "${code}" — looks like a gold cross, not gold-vs-USD, refusing.`);
    }
  }
}

const DEFAULT_BROKER_SYMBOL: Record<TrendBreakoutInstrumentId, string> = {
  EURUSD: 'EURUSD',
  XAUUSD: 'XAUUSD',
};

// §2 — "Initial configured volumes: EURUSD 0.12 lot, Gold 0.01 lot." Only
// ever read as the BOOTSTRAP seed for TrendBreakoutVolumeSetting the first
// time it's provisioned (volume-settings.service.ts) — once a setting row
// exists, this constant is never consulted again for that instrument.
export const DEFAULT_VOLUME_LOTS: Record<TrendBreakoutInstrumentId, number> = {
  EURUSD: 0.12,
  XAUUSD: 0.01,
};

/**
 * Resolves and validates both instruments' broker-symbol mappings from
 * config. Also rejects the SAME broker symbol being mapped to two different
 * instruments (a config-entry mistake that would otherwise silently make
 * one instrument's signals/orders apply to the other's actual market).
 */
export function resolveInstrumentMappings(config: ConfigService): Record<TrendBreakoutInstrumentId, InstrumentMapping> {
  const result = {} as Record<TrendBreakoutInstrumentId, InstrumentMapping>;
  for (const instrument of TREND_BREAKOUT_INSTRUMENTS) {
    const envKey = `TREND_BREAKOUT_${instrument === 'EURUSD' ? 'EURUSD' : 'GOLD'}_BROKER_SYMBOL`;
    const brokerSymbol = config.get<string>(envKey)?.trim() || DEFAULT_BROKER_SYMBOL[instrument];
    assertUnambiguousSymbol(instrument, brokerSymbol);
    result[instrument] = { instrument, brokerSymbol, defaultVolumeLots: DEFAULT_VOLUME_LOTS[instrument] };
  }
  if (result.EURUSD.brokerSymbol.toUpperCase() === result.XAUUSD.brokerSymbol.toUpperCase()) {
    throw new AmbiguousSymbolMappingError(
      `EURUSD and XAUUSD both resolve to the same broker symbol "${result.EURUSD.brokerSymbol}" — refusing this configuration.`,
    );
  }
  return result;
}
