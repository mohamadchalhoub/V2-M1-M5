import { Injectable } from '@nestjs/common';
import { CENTRAL_BANK_MEETING_IMPACT, CURATED_CENTRAL_BANK_MEETINGS } from './curated-central-bank-meetings';
import { MarketEventProvider, NormalizedMarketEvent } from './market-event-provider.interface';

/**
 * Objective 4 — no external HTTP call at all: the "provider" is the
 * hand-curated, officially-sourced list itself (curated-central-bank-
 * meetings.ts). Filters that static list to the requested window and
 * converts each meeting's local announcement time to UTC.
 */
@Injectable()
export class CentralBankCalendarProvider implements MarketEventProvider {
  async fetchEvents(range: { from: Date; to: Date }): Promise<NormalizedMarketEvent[]> {
    return CURATED_CENTRAL_BANK_MEETINGS.map((meeting) => ({
      meeting,
      scheduledAt: zonedDateAndTimeToUtc(meeting.date, meeting.announcementHour, meeting.announcementMinute, meeting.timezone),
    }))
      .filter(({ scheduledAt }) => scheduledAt >= range.from && scheduledAt <= range.to)
      .map(({ meeting, scheduledAt }) => ({
        source: meeting.source,
        externalId: meeting.date,
        category: 'ECONOMIC_EVENT',
        title: meeting.title,
        scheduleType: 'EXPECTED',
        impact: CENTRAL_BANK_MEETING_IMPACT,
        affectedCurrencies: meeting.affectedCurrencies,
        scheduledAt,
        rawPayload: meeting,
      }));
  }
}

/**
 * Converts a local calendar date + time in the given IANA timezone to UTC,
 * correct across that timezone's own DST boundary — same technique
 * market-event-ingestion.service.ts's etDateAndTimeToUtc already uses for
 * FRED (America/New_York only); generalized here to also support ECB's
 * Europe/Berlin announcements, reading the real offset from the platform's
 * own IANA timezone database rather than a fixed UTC offset that would be
 * wrong for roughly half the year.
 */
function zonedDateAndTimeToUtc(dateStr: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const zonedHourAtNoonUtc = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' })
      .formatToParts(noonUtc)
      .find((p) => p.type === 'hour')?.value,
  );
  const offsetHours = 12 - zonedHourAtNoonUtc;
  return new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute));
}
