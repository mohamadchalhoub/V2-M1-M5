import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';

// Builds the REAL application graph — AppModule as-is, nothing mocked —
// against whatever DATABASE_URL is currently in process.env (set by
// test/setup-env.ts to point at the disposable test database). This is
// deliberate: Phase 2's risk is integration and idempotency, not individual
// function correctness, so these tests exercise the real guard, controller,
// service, and Prisma client against a real Postgres instance.
export async function createTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
