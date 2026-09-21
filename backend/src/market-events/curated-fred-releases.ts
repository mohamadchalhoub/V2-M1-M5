import { MarketEventImpact } from '@prisma/client';

/**
 * FRED's /fred/releases/dates endpoint returns every release it tracks —
 * over 800 in a single 30-day window when tested live against this app's
 * real API key, the overwhelming majority of them routine daily data
 * updates (Dow Jones Averages, daily Treasury rates, Coinbase prices, etc.),
 * not discrete market-moving events. This is a hand-curated allowlist of
 * the release_ids that actually correspond to the kind of scheduled US
 * macro releases forex/CFD traders watch — every id below was looked up
 * against FRED's real /fred/releases catalog during this feature's build
 * (production readiness review, market-events phase), not guessed.
 * Anything not listed here is ingested by no one; add a new entry only
 * after confirming the real release_id the same way.
 *
 * `typicalReleaseHourEt`/`typicalReleaseMinuteEt` are NOT from FRED —
 * /fred/releases/dates only ever gives a calendar DATE, never a time of
 * day. These are the well-established, publicly published standard release
 * times for each series (the BLS and BEA release most economic data at
 * 8:30am ET; the Federal Reserve announces FOMC decisions at 2:00pm ET) —
 * a real, stable, long-standing convention, not a guess, but still an
 * approximation: an actual release can shift by a few minutes.
 */
export interface CuratedFredRelease {
  releaseId: number;
  title: string;
  impact: MarketEventImpact;
  affectedCurrencies: string[];
  typicalReleaseHourEt: number;
  typicalReleaseMinuteEt: number;
}

export const CURATED_FRED_RELEASES: CuratedFredRelease[] = [
  {
    releaseId: 50,
    title: 'Employment Situation (Nonfarm Payrolls)',
    impact: 'HIGH',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 8,
    typicalReleaseMinuteEt: 30,
  },
  {
    releaseId: 10,
    title: 'Consumer Price Index (CPI)',
    impact: 'HIGH',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 8,
    typicalReleaseMinuteEt: 30,
  },
  // FOMC Press Release (release_id=101) was tried and deliberately dropped —
  // verified live against FRED's own /fred/release/dates?release_id=101
  // (production readiness review, market-events phase): it reports a
  // "release date" for literally every single calendar day, not the ~8/year
  // actual meeting dates, apparently because this release container also
  // covers a daily-updated linked series. There is no way to distinguish a
  // real decision day from a routine update within this same data, so
  // ingesting it would inject a permanent false "FOMC today" signal every
  // day rather than a real one 8 times a year — worse than not covering
  // FOMC at all. Every OTHER release below was checked the same way and
  // confirmed genuinely sparse (monthly, or weekly for jobless claims)
  // before being kept.
  {
    releaseId: 53,
    title: 'Gross Domestic Product (GDP)',
    impact: 'HIGH',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 8,
    typicalReleaseMinuteEt: 30,
  },
  {
    releaseId: 54,
    title: 'Personal Income and Outlays (incl. PCE Price Index)',
    impact: 'HIGH',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 8,
    typicalReleaseMinuteEt: 30,
  },
  {
    releaseId: 46,
    title: 'Producer Price Index (PPI)',
    impact: 'MEDIUM',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 8,
    typicalReleaseMinuteEt: 30,
  },
  {
    releaseId: 92,
    title: 'Retail Sales',
    impact: 'MEDIUM',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 8,
    typicalReleaseMinuteEt: 30,
  },
  {
    releaseId: 180,
    title: 'Unemployment Insurance Weekly Claims',
    impact: 'MEDIUM',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 8,
    typicalReleaseMinuteEt: 30,
  },
  {
    releaseId: 13,
    title: 'Industrial Production and Capacity Utilization',
    impact: 'LOW',
    affectedCurrencies: ['USD'],
    typicalReleaseHourEt: 9,
    typicalReleaseMinuteEt: 15,
  },
];

export function findCuratedRelease(releaseId: number): CuratedFredRelease | undefined {
  return CURATED_FRED_RELEASES.find((r) => r.releaseId === releaseId);
}
