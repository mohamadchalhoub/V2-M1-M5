import { PrismaClient } from '@prisma/client';
import { SimilarPastEvent } from './ai-provider.interface';

const MINUTE_MS = 60_000;

/**
 * AI_INTEGRATION_SPEC.md §6 — approximate, by design decision: the account's
 * last few Alert rows for the SAME rule (excluding this one), with
 * `briefOutcome` derived from the next Alert.triggeredAt for that rule as a
 * proxy for "how long until something changed." This is NOT exact episode
 * tracking (RuleState only keeps the latest resolution, RULE_ENGINE_SPEC.md
 * §12.12 point 5) — a rule that re-notified several times within one
 * episode will show several "resolved after N minutes" entries that are
 * really just re-notify gaps, not true resolutions. The copy this function
 * feeds into the AI prompt says "approximately," never a precise claim.
 */
export async function findSimilarPastEvents(
  prisma: PrismaClient,
  ruleId: string,
  excludeAlertId: string,
  limit = 3,
): Promise<SimilarPastEvent[]> {
  const past = await prisma.alert.findMany({
    where: { ruleId, id: { not: excludeAlertId } },
    orderBy: { triggeredAt: 'desc' },
    take: limit,
    select: { id: true, triggeredAt: true },
  });

  const events: SimilarPastEvent[] = [];
  for (const alert of past) {
    // Excludes the alert currently being analyzed — it's happening right
    // now, not a resolution of an OLDER alert, so it must never count as
    // "the next related alert" for the past event immediately before it.
    const next = await prisma.alert.findFirst({
      where: { ruleId, id: { not: excludeAlertId }, triggeredAt: { gt: alert.triggeredAt } },
      orderBy: { triggeredAt: 'asc' },
      select: { triggeredAt: true },
    });

    const briefOutcome = next
      ? `approximately ${Math.max(1, Math.round((next.triggeredAt.getTime() - alert.triggeredAt.getTime()) / MINUTE_MS))} minute(s) until the next related alert`
      : 'no further alerts for this rule recorded since';

    events.push({ alertId: alert.id, triggeredAt: alert.triggeredAt, briefOutcome });
  }
  return events;
}
