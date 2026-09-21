import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { setupAccountWithToken, validPositionPayload, validSnapshotPayload } from './helpers/factories';
import { request } from './helpers/http';

describe('position synchronization', () => {
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

  async function pushSnapshot(token: string, accountId: string, positions: unknown[]) {
    return request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(accountId, { positions }),
    });
  }

  it('inserts a new position as OPEN', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushSnapshot(token, account.id, [validPositionPayload({ externalPositionId: 'P1' })]);

    const rows = await prisma.position.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalPositionId).toBe('P1');
    expect(rows[0].status).toBe('OPEN');
  });

  it('updates an existing position rather than duplicating it', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushSnapshot(token, account.id, [
      validPositionPayload({ externalPositionId: 'P1', currentPrice: 1.1, profit: 0 }),
    ]);
    await pushSnapshot(token, account.id, [
      validPositionPayload({ externalPositionId: 'P1', currentPrice: 1.2, profit: 5 }),
    ]);

    const rows = await prisma.position.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].currentPrice)).toBe(1.2);
    expect(Number(rows[0].profit)).toBe(5);
  });

  it('handles multiple simultaneous positions in one push', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushSnapshot(token, account.id, [
      validPositionPayload({ externalPositionId: 'P1' }),
      validPositionPayload({ externalPositionId: 'P2' }),
      validPositionPayload({ externalPositionId: 'P3' }),
    ]);

    const rows = await prisma.position.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'OPEN')).toBe(true);
  });

  it('marks a position CLOSED when a later full snapshot no longer reports it', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushSnapshot(token, account.id, [validPositionPayload({ externalPositionId: 'P1' })]);
    await pushSnapshot(token, account.id, []); // full replace — nothing open now

    const rows = await prisma.position.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('CLOSED');
  });

  it("one account's empty snapshot does not close another account's open position", async () => {
    const acct1 = await setupAccountWithToken(prisma);
    const acct2 = await setupAccountWithToken(prisma);

    await pushSnapshot(acct1.token, acct1.account.id, [validPositionPayload({ externalPositionId: 'SHARED-LOOKING-ID' })]);
    await pushSnapshot(acct2.token, acct2.account.id, []); // account 2 reports nothing open

    const acct1Position = await prisma.position.findFirstOrThrow({ where: { accountId: acct1.account.id } });
    expect(acct1Position.status).toBe('OPEN');
  });
});
