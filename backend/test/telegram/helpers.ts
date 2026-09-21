import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, DeliveryStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppModule } from '../../src/app.module';
import { TELEGRAM_DELIVERY_QUEUE } from '../../src/jobs/jobs.constants';

/** Same pattern as test/rules/helpers.ts — the real DI graph, no HTTP listener. */
export async function buildTelegramTestContext() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const context: INestApplicationContext = await moduleRef.init();
  return {
    context,
    queue: context.get<Queue>(TELEGRAM_DELIVERY_QUEUE),
  };
}

/**
 * Polls Postgres (never Redis/BullMQ internals) for an AlertDelivery to
 * reach one of the given terminal-for-this-test statuses — the delivery
 * table is the system's own source of truth (PHASE5_DELIVERY_SPEC.md §1),
 * so asserting against it is exactly what a real caller would do.
 */
export async function waitForDeliveryStatus(
  prisma: PrismaClient,
  alertDeliveryId: string,
  statuses: DeliveryStatus[],
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<PrismaClient['alertDelivery']['findUniqueOrThrow']>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const delivery = await prisma.alertDelivery.findUniqueOrThrow({ where: { id: alertDeliveryId } });
    if (statuses.includes(delivery.status)) return delivery;
    if (Date.now() > deadline) {
      throw new Error(
        `AlertDelivery ${alertDeliveryId} did not reach [${statuses.join(', ')}] within ${timeoutMs}ms ` +
          `(currently ${delivery.status}, attempts=${delivery.attempts})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
