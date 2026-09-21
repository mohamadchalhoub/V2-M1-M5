/**
 * ONE coherent XAUUSD quote (§10).
 *
 * This exists because splitting a quote across two streams produced a
 * genuinely incoherent answer in the project this one was copied from: the
 * dashboard reported the price and broker timestamp from one stream while
 * reporting the AGE from whichever stream happened to be fresher, so a price
 * 34.5 seconds old was published with an age of 3.5 seconds and `fresh: true`.
 *
 * An age is a property OF a price, not of the feed in general. So price,
 * broker timestamp, age, freshness and source are resolved together here and
 * travel together everywhere afterwards. A newer timestamp from one stream can
 * never make an older price from another stream look fresh.
 *
 * ## Validation happens before selection
 *
 * Candidates are normalised and validated first, and only then is the newest
 * of the SURVIVORS chosen. Doing it the other way round lets a malformed but
 * newer row displace a perfectly usable older one, and the feed then looks
 * dead when it is merely noisy.
 *
 * ## Freshness is bounded on both sides
 *
 * A quote dated in the future is refused rather than treated as extremely
 * fresh. `age <= limit` alone accepts every negative age, and that blind spot
 * was live in the source project: while stored tick timestamps carried the
 * broker's wall clock, every observation was three hours ahead and the
 * staleness test could never reject anything.
 */
import { V2_FUTURE_OBSERVATION_TOLERANCE_MS, V2_QUOTE_MAX_STALENESS_SECONDS } from './safety-constants';

export type QuoteSource = 'live_ticks' | 'historical_ticks';

export interface ResolvedQuote {
  readonly bid: number;
  readonly ask: number;
  /** The BROKER's own timestamp for this quote, normalised to true UTC. */
  readonly tickAtMs: number;
  /** `(evaluatedAtMs - tickAtMs) / 1000`, so the relationship stays checkable. */
  readonly ageSeconds: number;
  readonly fresh: boolean;
  readonly source: QuoteSource;
  /** Mid, for the RSI projection. Derived here so callers cannot disagree. */
  readonly mid: number;
}

export interface QuoteCandidate {
  readonly bid: unknown;
  readonly ask: unknown;
  /** Broker timestamp, already normalised to true UTC exactly once. */
  readonly tickAtMs: number;
  readonly source: QuoteSource;
}

export type QuoteRejection = 'NO_CANDIDATES' | 'ALL_INVALID' | 'ALL_STALE_OR_FUTURE';

export interface QuoteResolution {
  readonly quote: ResolvedQuote | null;
  readonly rejection: QuoteRejection | null;
  readonly detail: string | null;
  /** Why each candidate was discarded, for the dashboard's limitations list. */
  readonly discarded: readonly string[];
}

function isUsablePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resolves the one quote to act on.
 *
 * `evaluatedAtMs` is an explicit server instant rather than an implicit
 * `Date.now()` inside the function: §10 requires schedule and age decisions to
 * use an explicit evaluation time, and it makes every case here testable.
 */
export function resolveQuote(
  candidates: readonly QuoteCandidate[],
  evaluatedAtMs: number,
): QuoteResolution {
  if (candidates.length === 0) {
    return {
      quote: null,
      rejection: 'NO_CANDIDATES',
      detail: 'No quote rows are available for XAUUSD. Nothing is observing the market.',
      discarded: [],
    };
  }

  const discarded: string[] = [];
  const valid: Array<QuoteCandidate & { bid: number; ask: number }> = [];

  for (const c of candidates) {
    if (!isUsablePrice(c.bid) || !isUsablePrice(c.ask)) {
      discarded.push(`${c.source}: unusable prices (bid=${String(c.bid)}, ask=${String(c.ask)}).`);
      continue;
    }
    if (c.ask < c.bid) {
      discarded.push(`${c.source}: crossed quote (bid=${c.bid} exceeds ask=${c.ask}).`);
      continue;
    }
    if (!Number.isFinite(c.tickAtMs)) {
      discarded.push(`${c.source}: unusable timestamp.`);
      continue;
    }
    valid.push({ ...c, bid: c.bid, ask: c.ask });
  }

  if (valid.length === 0) {
    return {
      quote: null,
      rejection: 'ALL_INVALID',
      detail: 'Every available quote row was malformed.',
      discarded,
    };
  }

  // Newest of the SURVIVORS.
  const chosen = valid.reduce((best, c) => (c.tickAtMs > best.tickAtMs ? c : best));

  const ageMs = evaluatedAtMs - chosen.tickAtMs;
  const ageSeconds = ageMs / 1000;

  if (ageMs < -V2_FUTURE_OBSERVATION_TOLERANCE_MS) {
    return {
      quote: null,
      rejection: 'ALL_STALE_OR_FUTURE',
      detail:
        `The newest quote is dated ${Math.abs(ageSeconds).toFixed(1)}s in the future, beyond what clock skew ` +
        'explains. This indicates a wrong timestamp conversion, not a very fresh quote, so it is refused.',
      discarded,
    };
  }

  const fresh = ageSeconds <= V2_QUOTE_MAX_STALENESS_SECONDS;

  return {
    quote: {
      bid: chosen.bid,
      ask: chosen.ask,
      tickAtMs: chosen.tickAtMs,
      ageSeconds,
      fresh,
      source: chosen.source,
      // Mid is what the RSI projection uses. Deriving it here, from the same
      // selected observation, is what stops one part of the system computing
      // RSI from one price while another reports a different one.
      mid: (chosen.bid + chosen.ask) / 2,
    },
    rejection: null,
    detail: fresh
      ? null
      : `The newest quote is ${ageSeconds.toFixed(1)}s old, beyond the ${V2_QUOTE_MAX_STALENESS_SECONDS}s ` +
        'freshness budget. Continuity is still tracked, but no signal may be formed from it.',
    discarded,
  };
}

/**
 * Asserts the coherence contract: every field describes the SAME observation.
 *
 * Cheap, and it catches the exact class of bug this module exists to prevent —
 * a caller assembling a quote from parts. Used in tests and at the boundary
 * where a quote is handed to the decision path.
 */
export function assertCoherent(quote: ResolvedQuote, evaluatedAtMs: number): void {
  const expectedAge = (evaluatedAtMs - quote.tickAtMs) / 1000;
  if (Math.abs(quote.ageSeconds - expectedAge) > 1e-6) {
    throw new Error(
      `Incoherent quote: ageSeconds ${quote.ageSeconds} does not match evaluatedAt - tickAt (${expectedAge}). ` +
        'Price, timestamp and age must describe the same observation.',
    );
  }
  const expectedFresh = quote.ageSeconds <= V2_QUOTE_MAX_STALENESS_SECONDS;
  if (quote.fresh !== expectedFresh) {
    throw new Error(
      `Incoherent quote: fresh=${quote.fresh} disagrees with ageSeconds ${quote.ageSeconds}.`,
    );
  }
}
