// Reliability/ops visibility — GET /collector/storage-health. No accountId,
// same posture as every other market-data route in this file.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';

describe('storage health (/collector/storage-health)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('returns a positive databaseSizeBytes and a checkedAt timestamp, never throwing over an unavailable WAL probe', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'GET',
      url: '/collector/storage-health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.databaseSizeBytes).toBe('number');
    expect(res.body.databaseSizeBytes).toBeGreaterThan(0);
    expect(res.body.walSizeBytes === null || typeof res.body.walSizeBytes === 'number').toBe(true);
    expect(() => new Date(res.body.checkedAt).toISOString()).not.toThrow();
  });

  it('rejects a request with no bearer token', async () => {
    const res = await request(app, { method: 'GET', url: '/collector/storage-health' });
    expect(res.statusCode).toBe(401);
  });
});
