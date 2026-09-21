import { PrismaClient } from '@prisma/client';
import { AnalyticsService } from '../../src/analytics/analytics.service';

/**
 * Builds an AnalyticsService without going through Nest's DI container —
 * this module has no HTTP surface (ANALYTICS_SPEC.md §0), so there is no
 * app-level integration point to test through; a plain instantiation against
 * the real Prisma client is the most direct way to exercise it against
 * Postgres. `windowDaysOverride` stands in for ConfigService so tests never
 * depend on process.env for the baseline window.
 */
export function analyticsServiceFor(prisma: PrismaClient, windowDaysOverride?: number): AnalyticsService {
  const fakeConfig = {
    get: () => (windowDaysOverride === undefined ? undefined : String(windowDaysOverride)),
  };
  return new AnalyticsService(prisma as any, fakeConfig as any);
}
