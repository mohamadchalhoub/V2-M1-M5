import { BadRequestException, Controller, Get, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { HealthComponent } from '@prisma/client';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { HealthService } from './health.service';

const VALID_COMPONENTS = new Set<string>([
  'COLLECTOR',
  'MT5_TERMINAL',
  'DATABASE',
  'REDIS',
  'TELEGRAM',
  'AI_PROVIDER',
  'XTB_IMPORT',
  'DATA_INTEGRITY',
]);

// Dashboard-authenticated (production-readiness review — Option B) — but
// NOT at the class level, deliberately: /health/live below must stay
// unauthenticated for Docker's own container healthcheck
// (docker-compose.prod.yml), which cannot carry a dashboard bearer token.
// Guarding each real route individually, rather than class-level with an
// exception carved out elsewhere, keeps that boundary visible right here
// rather than split across two files.
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Deliberately UNAUTHENTICATED and deliberately minimal — this is what
  // docker-compose.prod.yml's `api` healthcheck polls, from inside the
  // container itself, which has no dashboard token to present. Exposes only
  // a boolean-shaped answer, never the per-component detail /health below
  // does (no COLLECTOR/TELEGRAM/AI_PROVIDER/etc. status, no operational
  // detail) — enough for "should this container be considered healthy,"
  // nothing an outside caller could use for reconnaissance.
  @Get('live')
  async getLiveness() {
    const status = await this.health.getAggregateStatus();
    const healthy = status.DATABASE.status !== 'DOWN' && status.REDIS.status !== 'DOWN';
    if (!healthy) {
      throw new ServiceUnavailableException({ status: 'unhealthy' });
    }
    return { status: 'ok' };
  }

  @Get()
  @UseGuards(DashboardTokenGuard)
  async getHealth() {
    return this.health.getAggregateStatus();
  }

  @Get('incidents')
  @UseGuards(DashboardTokenGuard)
  async getIncidents(@Query('component') component?: string) {
    if (component && !VALID_COMPONENTS.has(component)) {
      throw new BadRequestException(`Unknown component "${component}". Valid: ${[...VALID_COMPONENTS].join(', ')}`);
    }
    return this.health.getIncidents(component as HealthComponent | undefined);
  }
}
