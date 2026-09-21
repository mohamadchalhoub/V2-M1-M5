import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { setupAccountWithToken, validSnapshotPayload } from './helpers/factories';
import { request } from './helpers/http';

describe('collector heartbeat', () => {
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

  async function pushSnapshot(token: string, accountId: string, overrides: Record<string, unknown> = {}) {
    return request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(accountId, overrides),
    });
  }

  it('is written when an authenticated collector pushes a snapshot', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushSnapshot(token, account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/collector/heartbeat/${account.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.lastHeartbeatAt).not.toBeNull();
  });

  it('updates the existing row rather than creating a new one', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushSnapshot(token, account.id);
    const first = await prisma.collectorHeartbeat.findUniqueOrThrow({ where: { accountId: account.id } });

    await new Promise((r) => setTimeout(r, 5));
    await pushSnapshot(token, account.id);

    const rows = await prisma.collectorHeartbeat.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].lastHeartbeatAt.getTime()).toBeGreaterThan(first.lastHeartbeatAt.getTime());
  });

  it('stores MT5 connection status and clears a previous error once resolved', async () => {
    const { account, token } = await setupAccountWithToken(prisma);

    await pushSnapshot(token, account.id, { terminal: { connected: false, lastError: 'IPC timeout' } });
    let hb = await prisma.collectorHeartbeat.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(hb.mt5Connected).toBe(false);
    expect(hb.lastError).toBe('IPC timeout');

    await pushSnapshot(token, account.id, { terminal: { connected: true } });
    hb = await prisma.collectorHeartbeat.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(hb.mt5Connected).toBe(true);
    expect(hb.lastError).toBeNull();
  });

  it('stores the reported collector version', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushSnapshot(token, account.id, { collectorVersion: '0.2.7-test' });

    const hb = await prisma.collectorHeartbeat.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(hb.collectorVersion).toBe('0.2.7-test');
  });
});
