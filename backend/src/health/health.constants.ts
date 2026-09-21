import { HealthComponent } from '@prisma/client';

/** Redis key for one component's live status — HEALTH_SPEC.md §2 ("Redis first, Postgres second"). */
export function redisHealthKey(component: HealthComponent): string {
  return `health:status:${component}`;
}
