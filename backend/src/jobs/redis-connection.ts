import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

/**
 * One factory, two independent connection instances (§ below) — BullMQ's
 * documented recommendation is a dedicated connection per Queue/Worker
 * rather than sharing one, so a Worker's blocking read never contends with
 * a Queue producer's `add()` calls. `maxRetriesPerRequest: null` is
 * REQUIRED by BullMQ for any connection handed to a `Worker`/`QueueEvents`
 * (blocking commands); harmless for a plain `Queue` connection too, so it's
 * applied uniformly rather than as a special case.
 */
export function createRedisConnection(config: ConfigService): IORedis {
  const url = config.get<string>('REDIS_URL')?.trim();
  if (!url) {
    throw new Error('Missing required configuration: REDIS_URL. See backend/.env.example.');
  }
  return new IORedis(url, { maxRetriesPerRequest: null });
}
