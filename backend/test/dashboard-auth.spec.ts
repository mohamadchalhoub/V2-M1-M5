// Dashboard authentication (production-readiness review — Option B).
// Mirrors test/auth.spec.ts's structure exactly, against GET /accounts/:id
// as the representative account-scoped dashboard route. A genuinely
// separate guard from the collector's — see the "collector token used
// against a dashboard route" test below for the explicit proof the two
// never accept each other's tokens.
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/auth/token.util';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import {
  createCollectorToken,
  createDashboardToken,
  createTradingAccount,
  createUser,
} from './helpers/factories';
import { request } from './helpers/http';

describe('dashboard authentication', () => {
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

  async function seedAccount() {
    const user = await createUser(prisma);
    return createTradingAccount(prisma, user.id);
  }

  it('1. accepts a valid dashboard token', async () => {
    const account = await seedAccount();
    const { plaintext } = await createDashboardToken(prisma, account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('2. missing Authorization header -> 401', async () => {
    const account = await seedAccount();
    const res = await request(app, { method: 'GET', url: `/accounts/${account.id}` });
    expect(res.statusCode).toBe(401);
  });

  it('3. malformed Authorization header -> 401', async () => {
    const account = await seedAccount();
    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: 'NotBearer something' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('4. invalid token -> 401', async () => {
    const account = await seedAccount();
    await createDashboardToken(prisma, account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: 'Bearer tm_dsh_totally_wrong_00000000000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('5. revoked token -> 401', async () => {
    const account = await seedAccount();
    const { plaintext, credential } = await createDashboardToken(prisma, account.id);
    await prisma.apiCredential.update({ where: { id: credential.id }, data: { revokedAt: new Date() } });

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('6. a collector token used against a dashboard route -> 401 (never accepted, wrong scope)', async () => {
    const account = await seedAccount();
    const { plaintext: collectorToken } = await createCollectorToken(prisma, account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('7. a dashboard token with a null accountId -> 401, never treated as unrestricted', async () => {
    const account = await seedAccount();
    const { plaintext, credential } = await createDashboardToken(prisma, account.id);
    await prisma.apiCredential.update({ where: { id: credential.id }, data: { accountId: null } });

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('8. a dashboard token bound to account A requesting account B -> 403', async () => {
    const accountA = await seedAccount();
    const accountB = await seedAccount();
    const { plaintext } = await createDashboardToken(prisma, accountA.id);

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${accountB.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('9. a dashboard token bound to account A requesting account A -> accepted', async () => {
    const accountA = await seedAccount();
    const { plaintext } = await createDashboardToken(prisma, accountA.id);

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${accountA.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a token that shares a valid prefix but differs after it is rejected', async () => {
    const account = await seedAccount();
    const { plaintext } = await createDashboardToken(prisma, account.id);
    const tampered = plaintext.slice(0, -4) + 'XXXX';

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores only an argon2id hash of the token, never the plaintext', async () => {
    const account = await seedAccount();
    const { plaintext, credential } = await createDashboardToken(prisma, account.id);
    const stored = await prisma.apiCredential.findUniqueOrThrow({ where: { id: credential.id } });

    expect(stored.tokenHash).not.toBe(plaintext);
    expect(stored.tokenHash).not.toContain(plaintext);
    expect(stored.tokenHash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies against the stored hash — corrupting the hash breaks auth for an otherwise-correct token', async () => {
    const account = await seedAccount();
    const { plaintext, credential } = await createDashboardToken(prisma, account.id);
    await prisma.apiCredential.update({
      where: { id: credential.id },
      data: { tokenHash: await hashToken('a-completely-different-token') },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never logs the plaintext token, even when a request is rejected', async () => {
    const account = await seedAccount();
    const plaintext = 'tm_dsh_this_exact_secret_must_never_appear_in_any_log_line';
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);

    await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });

    const loggedText = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
    expect(loggedText).not.toContain(plaintext);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('a dashboard token is rejected on a collector route (401, never accepted as a collector token)', async () => {
    const account = await seedAccount();
    const { plaintext: dashboardToken } = await createDashboardToken(prisma, account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/collector/cursor/${account.id}`,
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
