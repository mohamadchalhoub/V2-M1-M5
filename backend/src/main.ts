import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Dashboard (Phase 9) — the only cross-origin consumer of this API today.
  // Every dashboard-read route is also guarded by DashboardTokenGuard
  // (account-bound bearer token, see auth/dashboard-token.guard.ts); this
  // allowlist is a second, origin-level layer in front of that, not the only
  // access control.
  const dashboardOrigins = (process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: dashboardOrigins });

  // Phase 5 — lets NestJS call onModuleDestroy (closes the BullMQ Worker and
  // Queue's Redis connections) on SIGTERM/SIGINT, not just on an explicit
  // app.close() in tests — required for a clean worker restart/shutdown.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // Phase 5 Req. 9 — invalid/missing config (e.g. TELEGRAM_BOT_TOKEN) throws
  // during DI container construction, before app.listen(); surface it
  // clearly and exit non-zero rather than an opaque unhandled rejection.
  Logger.error(err instanceof Error ? err.message : String(err), 'Bootstrap');
  process.exit(1);
});
