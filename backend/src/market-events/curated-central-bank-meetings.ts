import { MarketEventImpact } from '@prisma/client';

/**
 * Objective 4 (economic calendar gap) — FOMC rate decisions were tried via
 * FRED and deliberately dropped (curated-fred-releases.ts's own comment:
 * release_id=101 reports a "release date" every calendar day, not the real
 * ~8/year meeting dates) and ECB decisions were never covered by any
 * existing provider at all. Both central banks publish their own meeting
 * calendars officially, months in advance, only ~8 times a year each — a
 * small hand-curated list is a more reliable source for these specific
 * dates than any API, and needs no external HTTP call, no API key, and
 * carries no rate-limit risk. Verified against the Fed's and ECB's own
 * published 2026 calendars at build time (not from memory):
 * https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm and
 * https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html.
 *
 * `date` is the DECISION day (FOMC's second day; ECB's Governing Council
 * "Day 2") — the day the actual rate announcement is made, not the first
 * day of a two-day meeting. Update this list when each bank publishes its
 * next year's calendar (typically mid-prior-year) — verify against the
 * official pages above again rather than guessing next year's cadence.
 */
export interface CuratedCentralBankMeeting {
  source: 'FOMC' | 'ECB';
  /** ISO date (YYYY-MM-DD) of the decision/announcement day. */
  date: string;
  title: string;
  affectedCurrencies: string[];
  announcementHour: number;
  announcementMinute: number;
  /** IANA timezone the announcement hour/minute above is expressed in. */
  timezone: string;
}

export const CURATED_CENTRAL_BANK_MEETINGS: CuratedCentralBankMeeting[] = [
  // FOMC 2026 — 8 scheduled meetings, decisions announced 2:00pm ET
  // (federalreserve.gov/monetarypolicy/fomccalendars.htm).
  ...(['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'] as const).map(
    (date): CuratedCentralBankMeeting => ({
      source: 'FOMC',
      date,
      title: 'FOMC Interest Rate Decision',
      affectedCurrencies: ['USD'],
      announcementHour: 14,
      announcementMinute: 0,
      timezone: 'America/New_York',
    }),
  ),
  // ECB Governing Council monetary policy meetings 2026 — decisions
  // announced 14:15 CET/CEST, press conference 14:45
  // (ecb.europa.eu/press/calendars/mgcgc/html/index.en.html).
  ...(['2026-03-19', '2026-04-30', '2026-06-11', '2026-07-23', '2026-09-10', '2026-10-29', '2026-12-17'] as const).map(
    (date): CuratedCentralBankMeeting => ({
      source: 'ECB',
      date,
      title: 'ECB Governing Council Interest Rate Decision',
      affectedCurrencies: ['EUR'],
      announcementHour: 14,
      announcementMinute: 15,
      timezone: 'Europe/Berlin',
    }),
  ),
];

export const CENTRAL_BANK_MEETING_IMPACT: MarketEventImpact = 'HIGH';
