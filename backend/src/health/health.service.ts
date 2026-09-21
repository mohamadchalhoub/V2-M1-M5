import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthComponent } from '@prisma/client';
import IORedis from 'ioredis';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { redisHealthKey } from './health.constants';

export interface ComponentStatusView {
  status: string;
  detail: unknown;
  checkedAt: string | null;
}

const ALL_COMPONENTS: HealthComponent[] = [
  'COLLECTOR',
  'MT5_TERMINAL',
  'DATABASE',
  'REDIS',
  'TELEGRAM',
  'AI_PROVIDER',
  'XTB_IMPORT',
  'DATA_INTEGRITY',
];

/**
 * The read side for `GET /health`. Tries Redis first (the fast, DB-outage-
 * resilient path HealthCheckProcessor writes to); falls back to Postgres
 * only if Redis itself is unreachable from HERE too — matching the same
 * "never assume the thing you're checking is up" posture as the checks
 * themselves.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.redis = createRedisConnection(config);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async getAggregateStatus(): Promise<Record<HealthComponent, ComponentStatusView>> {
    const entries = await Promise.all(ALL_COMPONENTS.map(async (c) => [c, await this.getComponentStatus(c)] as const));
    return Object.fromEntries(entries) as Record<HealthComponent, ComponentStatusView>;
  }

  private async getComponentStatus(component: HealthComponent): Promise<ComponentStatusView> {
    try {
      const raw = await this.redis.get(redisHealthKey(component));
      if (raw) return JSON.parse(raw) as ComponentStatusView;
    } catch {
      // Redis unreachable from the read side too — fall through to Postgres.
    }

    const row = await this.prisma.healthStatus.findUnique({ where: { component } });
    if (!row) {
      return { status: 'DEGRADED', detail: { reason: 'no check has run yet' }, checkedAt: null };
    }
    return { status: row.status, detail: row.detail, checkedAt: row.checkedAt.toISOString() };
  }

  async getIncidents(component?: HealthComponent, limit = 50) {
    return this.prisma.healthIncident.findMany({
      where: component ? { component } : undefined,
      orderBy: { openedAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }
}
