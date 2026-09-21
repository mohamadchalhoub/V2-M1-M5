// Regression tests for the bug found during the production-readiness
// review: `persistAndDetectIncident`'s Postgres calls could throw
// uncaught, which — since `HealthCheckProcessor.runChecks()` calls it once
// per component inside a single `for...of` loop — aborted the loop
// entirely. Every component AFTER the failing one in iteration order kept
// serving stale, silently-still-"OK" cached data for as long as the
// failure lasted. Reproduced live this session by stopping the dev
// Postgres container for several minutes and observing exactly that.
//
// These tests reproduce it deterministically via targeted Prisma mocks
// (real Postgres/Redis otherwise) rather than actually stopping the
// disposable test database, which other test files share concurrently.
//
// Assertions read back through GET /health (Redis-first, same as the real
// read path) rather than querying `health_status` directly — this table has
// no account scoping, so a concurrently-running test file's own
// resetDatabase() can legitimately wipe it between a write and a raw-query
// read here (the same hazard health-e2e.spec.ts already works around).
// Redis is per-component keys no other file's reset touches, so reading via
// the real endpoint is both more representative and race-free.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';
import { HealthCheckProcessor } from '../../src/health/health-check.processor';
import { PrismaService } from '../../src/prisma/prisma.service';

// What HealthCheckProcessor.runChecks() itself processes in its loop —
// DATA_INTEGRITY is deliberately NOT one of these: it's a separate
// component checked by DataIntegrityProcessor, on its own queue/schedule,
// never touched by this processor's tick at all.
const HEALTH_CHECK_LOOP_COMPONENTS = [
  'COLLECTOR',
  'MT5_TERMINAL',
  'DATABASE',
  'REDIS',
  'TELEGRAM',
  'AI_PROVIDER',
  'XTB_IMPORT',
];

describe('health-check loop resilience (production-readiness review — regression)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let appPrisma: PrismaService;
  let processor: HealthCheckProcessor;
  let dashboardToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
    appPrisma = app.get(PrismaService);
    processor = app.get(HealthCheckProcessor);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    // /health is system-wide, not account-scoped — any valid, unrevoked
    // dashboard token is accepted (see health-e2e.spec.ts for the same setup).
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    ({ plaintext: dashboardToken } = await createDashboardToken(prisma, account.id));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'a Postgres failure persisting ONE component does not stop later components from being ' +
      'checked and written — the exact bug: the loop used to abort at the first throw',
    async () => {
      // Fails deterministically for COLLECTOR specifically (by inspecting
      // the call's own `where.component`, not by call order/count, since
      // this app instance's health-check worker can also tick on its own
      // schedule concurrently with the explicit call below) — every OTHER
      // component's write must go through untouched.
      const originalUpsert = appPrisma.healthStatus.upsert.bind(appPrisma.healthStatus);
      vi.spyOn(appPrisma.healthStatus, 'upsert').mockImplementation((args: any) => {
        if (args?.where?.component === 'COLLECTOR') {
          return Promise.reject(new Error('simulated Postgres write failure for COLLECTOR'));
        }
        return originalUpsert(args);
      });

      await processor.runChecks();

      const res = await request(app, {
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${dashboardToken}` },
      });
      for (const component of HEALTH_CHECK_LOOP_COMPONENTS) {
        expect(res.body[component], component).toHaveProperty('status');
      }
      // Every component OTHER than the one whose Postgres write was made to
      // fail persisted a real, current row — proving the loop kept going
      // past the failure instead of aborting there (the pre-fix bug).
      const persisted = await prisma.healthStatus.findMany({
        where: { component: { in: HEALTH_CHECK_LOOP_COMPONENTS.filter((c) => c !== 'COLLECTOR') as any } },
      });
      expect(persisted.map((h) => h.component).sort()).toEqual(
        HEALTH_CHECK_LOOP_COMPONENTS.filter((c) => c !== 'COLLECTOR').sort(),
      );
    },
  );

  it(
    'a full Postgres outage (every persistence call fails) still lets every component be checked ' +
      'and its live status written to Redis — the live status must not depend on Postgres being up',
    async () => {
      vi.spyOn(appPrisma.healthStatus, 'findUnique').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
      vi.spyOn(appPrisma.healthStatus, 'upsert').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
      // DATABASE's own check also genuinely fails during a real outage —
      // simulated the same way, independent of the persistence-layer mocks
      // above (a different Prisma call, $queryRaw, not the healthStatus model).
      vi.spyOn(appPrisma, '$queryRaw').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));

      await processor.runChecks();

      const res = await request(app, {
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${dashboardToken}` },
      });
      expect(res.statusCode).toBe(200);
      // Every component in the loop answered for this tick — none of them
      // got stuck on stale data because an earlier one failed to persist.
      for (const component of HEALTH_CHECK_LOOP_COMPONENTS) {
        expect(res.body[component], component).toHaveProperty('status');
      }
      // DATABASE specifically must show the real, current DOWN status — not
      // a stale cached "OK" — even though Postgres itself (the thing that
      // would normally durably record that) is exactly what's unavailable.
      expect(res.body.DATABASE.status).toBe('DOWN');
      // REDIS, being unrelated to the simulated Postgres outage, is still
      // correctly and independently evaluated as OK in the same tick.
      expect(res.body.REDIS.status).toBe('OK');
    },
  );

  it('GET /health/live requires no token and reports 503 during a Postgres outage', async () => {
    vi.spyOn(appPrisma, '$queryRaw').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
    vi.spyOn(appPrisma.healthStatus, 'findUnique').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
    vi.spyOn(appPrisma.healthStatus, 'upsert').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
    await processor.runChecks();

    const res = await request(app, { method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(503);
  });

  it('recovers to OK once Postgres is reachable again, with every component still evaluated throughout', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.collectorHeartbeat.create({
      data: { accountId: account.id, lastHeartbeatAt: new Date(), mt5Connected: true },
    });

    // Outage tick.
    vi.spyOn(appPrisma, '$queryRaw').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
    vi.spyOn(appPrisma.healthStatus, 'findUnique').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
    vi.spyOn(appPrisma.healthStatus, 'upsert').mockRejectedValue(new Error('ECONNREFUSED (simulated)'));
    await processor.runChecks();

    let res = await request(app, {
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${dashboardToken}` },
      });
    expect(res.body.DATABASE.status).toBe('DOWN');
    expect(res.body.COLLECTOR.status).toBe('OK'); // still correctly evaluated during the outage, not stuck

    // Recovery: restore the real Prisma behavior and tick again.
    vi.restoreAllMocks();
    await processor.runChecks();

    res = await request(app, {
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${dashboardToken}` },
      });
    expect(res.body.DATABASE.status).toBe('OK');
    expect(res.body.COLLECTOR.status).toBe('OK');
  });
});
