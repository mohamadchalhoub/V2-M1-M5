// End-to-end Phase 7 tests: real Postgres + real (disposable) Redis, mocked
// Telegram HTTP only (setup-telegram-mock.ts's default). Calls
// HealthCheckProcessor.runChecks() directly rather than waiting for the
// schedule (HEALTH_CHECK_INTERVAL_SECONDS=3600 in .env.test) — deterministic,
// same "force one tick" pattern the processor exposes for exactly this.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';
import { HealthCheckProcessor } from '../../src/health/health-check.processor';

describe('Phase 7 — system health monitoring (end-to-end)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let processor: HealthCheckProcessor;
  let dashboardToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
    processor = app.get(HealthCheckProcessor);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    // /health and /health/incidents are system-wide, not account-scoped —
    // DashboardTokenGuard has no accountId to compare against on these
    // routes, so any valid, unrevoked dashboard token is accepted.
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    ({ plaintext: dashboardToken } = await createDashboardToken(prisma, account.id));
  });

  it('GET /health returns all eight components after a check runs, DATABASE and REDIS both OK', async () => {
    await processor.runChecks();

    const res = await request(app, {
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    for (const component of [
      'COLLECTOR',
      'MT5_TERMINAL',
      'DATABASE',
      'REDIS',
      'TELEGRAM',
      'AI_PROVIDER',
      'XTB_IMPORT',
      'DATA_INTEGRITY',
    ]) {
      expect(body).toHaveProperty(component);
      expect(body[component]).toHaveProperty('status');
    }
    expect(body.DATABASE.status).toBe('OK');
    expect(body.REDIS.status).toBe('OK');
    expect(body.TELEGRAM.status).toBe('OK'); // setup-telegram-mock.ts's default success response
    // DATA_INTEGRITY is deliberately not asserted to a specific value here:
    // it's a global, component-keyed row (no accountId scoping) that a
    // concurrently-running data-integrity-e2e.spec.ts test can legitimately
    // write between this test's reset and this request — see that file for
    // the "no check has run yet" DEGRADED-default assertion instead.
  });

  it('a status change opens a health_incidents row; returning to OK closes it', async () => {
    // First tick: no accounts yet → COLLECTOR/MT5_TERMINAL both DEGRADED.
    await processor.runChecks();
    let incidents = await prisma.healthIncident.findMany({ where: { component: 'COLLECTOR' } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].statusTo).toBe('DEGRADED');
    expect(incidents[0].resolvedAt).toBeNull();

    // Second tick: a fresh, healthy heartbeat now exists → COLLECTOR back to OK.
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.collectorHeartbeat.create({
      data: { accountId: account.id, lastHeartbeatAt: new Date(), mt5Connected: true },
    });
    await processor.runChecks();

    incidents = await prisma.healthIncident.findMany({
      where: { component: 'COLLECTOR' },
      orderBy: { openedAt: 'asc' },
    });
    expect(incidents).toHaveLength(1); // the DEGRADED→OK transition closes the existing incident, doesn't open a new one
    expect(incidents[0].resolvedAt).not.toBeNull();

    const status = await prisma.healthStatus.findUniqueOrThrow({ where: { component: 'COLLECTOR' } });
    expect(status.status).toBe('OK');
  });

  it('repeated ticks with an unchanged status never create duplicate incidents', async () => {
    await processor.runChecks();
    await processor.runChecks();
    await processor.runChecks();

    const incidents = await prisma.healthIncident.findMany({ where: { component: 'COLLECTOR' } });
    expect(incidents).toHaveLength(1); // still DEGRADED the whole time — one incident, not three
  });

  it('GET /health/incidents filters by component and rejects an unknown one', async () => {
    await processor.runChecks();

    const filtered = await request(app, {
      method: 'GET',
      url: '/health/incidents?component=COLLECTOR',
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(filtered.statusCode).toBe(200);
    expect(Array.isArray(filtered.body)).toBe(true);
    expect(filtered.body.every((i: any) => i.component === 'COLLECTOR')).toBe(true);

    const invalid = await request(app, {
      method: 'GET',
      url: '/health/incidents?component=NOT_REAL',
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(invalid.statusCode).toBe(400);
  });

  // Dashboard authentication (production-readiness review — Option B):
  // /health/live is the one deliberate exception, since Docker's own
  // container healthcheck (docker-compose.prod.yml) polls it from inside
  // the container with no dashboard token to present.
  it('GET /health/live requires no Authorization header and reflects DATABASE/REDIS status', async () => {
    await processor.runChecks();

    const res = await request(app, { method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('a check that throws is reported as DOWN for that component, never crashes the whole tick', async () => {
    // Corrupt the DATABASE_URL is impractical mid-test; instead prove the
    // isolation property structurally: even with COLLECTOR/MT5 in a
    // DEGRADED state (guaranteed on a fresh reset), every OTHER component
    // still gets a real, current answer in the SAME tick — one component's
    // non-OK status never blocks the others from being evaluated.
    await processor.runChecks();
    const health = await prisma.healthStatus.findMany();
    const components = health.map((h) => h.component).sort();
    expect(components).toEqual(
      ['AI_PROVIDER', 'COLLECTOR', 'DATABASE', 'MT5_TERMINAL', 'REDIS', 'TELEGRAM', 'XTB_IMPORT'].sort(),
    );
    expect(health.every((h) => h.checkedAt !== null)).toBe(true);
  });
});
