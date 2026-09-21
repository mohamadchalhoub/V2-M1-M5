/**
 * ONE coherent XAUUSD quote, chosen from the streams the collector writes.
 *
 * This exists because splitting a quote across two streams produced a
 * genuinely incoherent answer in production. The dashboard reported
 * `tickAt` and `bid`/`ask` from `live_ticks` while reporting `ageSeconds`
 * from whichever stream was fresher, so a price 34.5 seconds old was
 * published with an age of 3.5 seconds and `fresh: true`. Measured on the
 * server:
 *
 *   evaluatedAt 13:30:11.495Z, tickAt 13:29:37.000Z, ageSeconds 3.547
 *
 * An age is a property OF a price, not of the feed in general. A newer
 * timestamp from one stream must never make an older price from another
 * stream look fresh, so price, broker timestamp, age and source are
 * resolved together here and travel together everywhere afterwards.
 *
 * The two sources differ in three ways that all matter:
 *
 *   - `live_ticks` holds one row per symbol, written once per collector
 *     snapshot cycle. That cycle also syncs candles across six timeframes
 *     for two symbols, so it lands every 25-45 seconds in practice.
 *     Its `tickAt` is already true UTC; the collector corrects it on the
 *     way in via `_mt5_time_to_utc`.
 *   - `historical_ticks` is written by the dedicated one-second XAUUSD
 *     observation thread and carries bid and ask, so it is a usable quote
 *     rather than mere evidence that the feed is alive. Its `timestamp`
 *     holds BROKER wall clock and must be converted exactly once.
 *   - Both can be absent, stale, or carry unusable prices.
 *
 * Selection is: normalise each candidate once, discard the invalid ones,
 * then take the newest of what remains. Validation comes before the choice
 * so a malformed newer row cannot displace a usable older one.
 */
import { RSI_FUTURE_OBSERVATION_TOLERANCE_MS, RSI_QUOTE_MAX_STALENESS_SECONDS } from './safety-constants';
import { storedBrokerTimeToUtcMs } from './tick-time';

/** Which stream a quote came from. Reported, never inferred by a caller. */
export type QuoteSource = 'live_ticks' | 'historical_ticks';

export interface ResolvedQuote {
  bid: number;
  ask: number;
  /** The BROKER's own timestamp for this quote, normalised to true UTC. */
  tickAtMs: number;
  /** `(evaluatedAtMs - tickAtMs) / 1000`, so the relationship is checkable. */
  ageSeconds: number;
  fresh: boolean;
  source: QuoteSource;
}

export interface QuoteCandidate {
  bid: unknown;
  ask: unknown;
  /** Raw stored timestamp, in whatever basis this source uses. */
  storedMs: number;
  source: QuoteSource;
}

export interface QuoteResolution {
  quote: ResolvedQuote | null;
  /** Present only when no usable quote exists; states the real reason. */
  blockedReason: string | null;
  /** Every candidate considered, with why it was kept or dropped. */
  considered: Array<{ source: QuoteSource; ageSeconds: number | null; rejected: string | null }>;
  evaluatedAtMs: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Prisma Decimal and anything else exposing toNumber().
  if (value !== null && typeof value === 'object' && 'toNumber' in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalises one candidate's timestamp to true UTC, exactly once.
 *
 * `live_ticks` is already corrected by the collector, so converting it
 * again would shift it by the broker offset a second time.
 */
function normaliseTimestamp(candidate: QuoteCandidate): number | null {
  if (!Number.isFinite(candidate.storedMs)) return null;
  return candidate.source === 'historical_ticks'
    ? storedBrokerTimeToUtcMs(candidate.storedMs)
    : candidate.storedMs;
}

/**
 * Picks the newest VALID quote, or explains why there is none.
 *
 * `evaluatedAtMs` is the single server instant every age is measured
 * against, and it is reported alongside the quote so a reader can verify
 * `ageSeconds === (evaluatedAt - tickAt) / 1000` rather than trust it.
 */
export function resolveQuote(candidates: readonly QuoteCandidate[], evaluatedAtMs: number): QuoteResolution {
  const considered: QuoteResolution['considered'] = [];
  const usable: ResolvedQuote[] = [];

  for (const candidate of candidates) {
    const tickAtMs = normaliseTimestamp(candidate);
    if (tickAtMs === null) {
      considered.push({ source: candidate.source, ageSeconds: null, rejected: 'timestamp is not a valid instant in the broker timezone' });
      continue;
    }

    const ageSeconds = (evaluatedAtMs - tickAtMs) / 1000;

    // Future-dated beyond ordinary clock skew means a wrong conversion or a
    // wrong clock, not an unusually fresh quote. Refused, never treated as
    // the freshest candidate.
    if (ageSeconds < -(RSI_FUTURE_OBSERVATION_TOLERANCE_MS / 1000)) {
      considered.push({ source: candidate.source, ageSeconds, rejected: `dated ${(-ageSeconds).toFixed(1)}s in the future, beyond the ${RSI_FUTURE_OBSERVATION_TOLERANCE_MS / 1000}s clock-skew tolerance` });
      continue;
    }

    const bid = toFiniteNumber(candidate.bid);
    const ask = toFiniteNumber(candidate.ask);
    if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) {
      considered.push({ source: candidate.source, ageSeconds, rejected: 'bid/ask are missing, non-finite, non-positive or crossed' });
      continue;
    }

    considered.push({ source: candidate.source, ageSeconds, rejected: null });
    usable.push({
      bid,
      ask,
      tickAtMs,
      ageSeconds,
      fresh: ageSeconds <= RSI_QUOTE_MAX_STALENESS_SECONDS,
      source: candidate.source,
    });
  }

  if (usable.length === 0) {
    const detail = considered.length === 0
      ? 'no XAUUSD quote has been recorded by either stream'
      : considered.map((c) => `${c.source}: ${c.rejected}`).join('; ');
    return { quote: null, blockedReason: `No usable XAUUSD quote — ${detail}.`, considered, evaluatedAtMs };
  }

  // Newest of the VALID ones. Validation deliberately precedes selection, so
  // a malformed newer row cannot displace a usable older one.
  const quote = usable.reduce((best, c) => (c.tickAtMs > best.tickAtMs ? c : best));

  if (!quote.fresh) {
    return {
      quote,
      blockedReason: `The newest usable XAUUSD quote is ${quote.ageSeconds.toFixed(1)}s old (limit ${RSI_QUOTE_MAX_STALENESS_SECONDS}s), from ${quote.source}.`,
      considered,
      evaluatedAtMs,
    };
  }

  return { quote, blockedReason: null, considered, evaluatedAtMs };
}
