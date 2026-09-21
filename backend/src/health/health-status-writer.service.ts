import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthComponent, HealthStatusValue, Prisma } from '@prisma/client';
import IORedis from 'ioredis';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { ComponentCheckResult } from './health-checks';
import { redisHealthKey } from './health.constants';
import { GoldTelegramService } from '../gold-execution/gold-telegram.service';

/**
 * The write side shared by every check worker (originally
 * `HealthCheckProcessor`'s private methods, extracted in Phase 11 when
 * `DataIntegrityProcessor` needed the exact same "Redis first, Postgres
 * second, open/close an incident on a status CHANGE only" logic — this
 * keeps that logic defined once, since a bug in it would silently affect
 * every component's history, not just one check's).
 */
@Injectable()
export class HealthStatusWriterService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthStatusWriterService.name);
  private readonly redis: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly goldTelegram: GoldTelegramService,
  ) {
    this.redis = createRedisConnection(config);
  }

  async writeRedis(component: HealthComponent, result: ComponentCheckResult, checkedAt: Date): Promise<void> {
    try {
      await this.redis.set(
        redisHealthKey(component),
        JSON.stringify({ status: result.status, detail: result.detail, checkedAt: checkedAt.toISOString() }),
      );
    } catch {
      // Redis is unreachable — exactly what the REDIS component's own check
      // (in the same tick, for HealthCheckProcessor) will already report as DOWN.
    }
  }

  // Bug fix (production-readiness review): this used to let a Postgres
  // error propagate straight out of here. Since every caller invokes this
  // once per component inside a `for...of` loop (HealthCheckProcessor.
  // runChecks()), an uncaught throw for ONE component aborted the loop
  // entirely — every component after it in iteration order kept serving
  // stale, silently-still-"OK" cached data for as long as the outage
  // lasted, which is exactly the dependency HEALTH_SPEC.md §2 says this
  // system must not have ("a database outage... must not depend on the
  // database being up to report that"). writeRedis() (called before this,
  // per iteration) already succeeded independently of Postgres, so the
  // live status is already correct by the time this runs — a failure here
  // now only means "no history/incident recorded for this tick," which is
  // the documented degradation (Phase 0 §13: a Postgres outage degrades the
  // health system to no history being recorded, it does not take the
  // health system down), not "the rest of this tick never happens."
  async persistAndDetectIncident(component: HealthComponent, result: ComponentCheckResult, checkedAt: Date): Promise<void> {
    try {
      const previous = await this.prisma.healthStatus.findUnique({ where: { component } });
      const previousStatus: HealthStatusValue = previous?.status ?? 'OK';
      const detail = (result.detail ?? {}) as Prisma.InputJsonValue;

      await this.prisma.healthStatus.upsert({
        where: { component },
        create: { component, status: result.status, detail, checkedAt },
        update: { status: result.status, detail, checkedAt },
      });

      if (previousStatus === result.status) {
        return;
      }

      await this.prisma.healthIncident.updateMany({
        where: { component, resolvedAt: null },
        data: { resolvedAt: checkedAt },
      });

      if (result.status !== 'OK') {
        await this.prisma.healthIncident.create({
          data: { component, statusFrom: previousStatus, statusTo: result.status, detail, openedAt: checkedAt },
        });
        this.logger.warn(`health incident: ${component} ${previousStatus} → ${result.status}`);
      }

      // Gold-specific outage/recovery notification — COLLECTOR only (the
      // component the collector/scheduler outage detection task item maps
      // to; see HEALTH_SPEC.md §3's COLLECTOR/MT5_TERMINAL split). Reuses
      // this existing status-change detection rather than inventing a
      // separate detector — fires on every transition INTO or OUT OF a
      // non-OK status, deliberately not gated on gold execution mode (an
      // operator needs this even while GOLD_EXECUTION_MODE=OFF/SHADOW).
      if (component === 'COLLECTOR') {
        if (result.status !== 'OK') {
          void this.goldTelegram.notify(
            'COLLECTOR_OUTAGE',
            `collector-outage:${checkedAt.toISOString()}`,
            `GOLD DEMO — collector outage detected. status ${previousStatus} -> ${result.status} at ${checkedAt.toISOString()}. detail=${JSON.stringify(detail)}`,
          );
        } else {
          void this.goldTelegram.notify(
            'COLLECTOR_RECOVERY',
            `collector-recovery:${checkedAt.toISOString()}`,
            `GOLD DEMO — collector recovered. status ${previousStatus} -> OK at ${checkedAt.toISOString()}.`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `failed to persist health status/incident for ${component} (Redis-side status is unaffected): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
