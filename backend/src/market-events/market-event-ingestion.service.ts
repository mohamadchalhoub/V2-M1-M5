import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { findCuratedRelease } from './curated-fred-releases';
import { FredClient } from './fred-client';
import { MarketEventsConfig } from './market-events.config';

/**
 * Upserts one MarketEvent row per (curated release, occurrence date) —
 * idempotent by design (schema's `@@unique([source, externalId,
 * scheduledAt])`), so re-running this on a schedule never duplicates an
 * event it already knows about. A release id not on the curated allowlist
 * is silently skipped, not stored — see curated-fred-releases.ts for why.
 */
@Injectable()
export class MarketEventIngestionService {
  private readonly logger = new Logger(MarketEventIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fredClient: FredClient,
  ) {}

  async ingest(config: MarketEventsConfig): Promise<{ upserted: number; skipped: number }> {
    const from = new Date();
    const to = new Date(from.getTime() + config.lookaheadDays * 86_400_000);
    const releaseDates = await this.fredClient.getUpcomingReleaseDates(
      config.fredApiKey,
      toDateString(from),
      toDateString(to),
    );

    let upserted = 0;
    let skipped = 0;

    for (const release of releaseDates) {
      const curated = findCuratedRelease(release.releaseId);
      if (!curated) {
        skipped++;
        continue;
      }

      const scheduledAt = etDateAndTimeToUtc(release.date, curated.typicalReleaseHourEt, curated.typicalReleaseMinuteEt);

      await this.prisma.marketEvent.upsert({
        where: {
          source_externalId_scheduledAt: {
            source: 'FRED',
            externalId: String(release.releaseId),
            scheduledAt,
          },
        },
        create: {
          source: 'FRED',
          externalId: String(release.releaseId),
          category: 'ECONOMIC_EVENT',
          title: curated.title,
          scheduleType: 'EXPECTED',
          impact: curated.impact,
          sentiment: 'UNCERTAIN',
          affectedCurrencies: curated.affectedCurrencies,
          scheduledAt,
          rawPayload: release as unknown as object,
        },
        update: {
          // Title/impact/currencies can only change if this table's own
          // curated allowlist changes (re-ingesting doesn't alter them
          // otherwise) — updated anyway so a corrected allowlist entry
          // heals existing rows on the next tick rather than needing a
          // manual backfill.
          title: curated.title,
          impact: curated.impact,
          affectedCurrencies: curated.affectedCurrencies,
          rawPayload: release as unknown as object,
        },
      });
      upserted++;
    }

    this.logger.log(`market-event ingestion: ${upserted} upserted, ${skipped} skipped (not in curated allowlist)`);
    return { upserted, skipped };
  }
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * FRED gives a plain calendar date with no timezone; the curated table's
 * release times are Eastern Time (ET) — the real timezone every one of
 * these US releases is actually scheduled in. Rather than hand-roll the
 * US DST transition rule, this reads America/New_York's actual UTC offset
 * for the given date from the platform's own IANA timezone database (the
 * same technique analytics/trading-day.ts already uses for per-account
 * trading-day boundaries) — correct across the EST/EDT boundary, not a
 * fixed UTC-5 approximation that would be an hour off for roughly half the
 * year.
 */
function etDateAndTimeToUtc(dateStr: string, hourEt: number, minuteEt: number): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const etHourAtNoonUtc = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' })
      .formatToParts(noonUtc)
      .find((p) => p.type === 'hour')?.value,
  );
  const offsetHours = 12 - etHourAtNoonUtc; // 5 for EST, 4 for EDT
  return new Date(Date.UTC(year, month - 1, day, hourEt + offsetHours, minuteEt));
}
