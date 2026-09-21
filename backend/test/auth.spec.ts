import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/auth/token.util';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { createCollectorToken, createTradingAccount, createUser } from './helpers/factories';
import { request } from './helpers/http';

describe('collector authentication', () => {
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

  it('accepts a valid collector token', async () => {
    const account = await seedAccount();
    const { plaintext } = await createCollectorToken(prisma, account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/collector/cursor/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a request with no token', async () => {
    const account = await seedAccount();
    const res = await request(app, { method: 'GET', url: `/collector/cursor/${account.id}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid token', async () => {
    const account = await seedAccount();
    await createCollectorToken(prisma, account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/collector/cursor/${account.id}`,
      headers: { authorization: 'Bearer tm_col_totally_wrong_00000000000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token that shares a valid prefix but differs after it', async () => {
    const account = await seedAccount();
    const { plaintext } = await createCollectorToken(prisma, account.id);
    const tampered = plaintext.slice(0, -4) + 'XXXX'; // same 8-char prefix, wrong suffix

    const res = await request(app, {
      method: 'GET',
      url: `/collector/cursor/${account.id}`,
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked token', async () => {
    const account = await seedAccount();
    const { plaintext, credential } = await createCollectorToken(prisma, account.id);
    await prisma.apiCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date() },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/collector/cursor/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores only an argon2id hash of the token, never the plaintext', async () => {
    const account = await seedAccount();
    const { plaintext, credential } = await createCollectorToken(prisma, account.id);
    const stored = await prisma.apiCredential.findUniqueOrThrow({ where: { id: credential.id } });

    expect(stored.tokenHash).not.toBe(plaintext);
    expect(stored.tokenHash).not.toContain(plaintext);
    expect(stored.tokenHash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies against the stored hash — corrupting the hash breaks auth for an otherwise-correct token', async () => {
    // Proves the guard actually checks the hash and not just the prefix
    // lookup: two tokens colliding on an 8-char prefix is not something we
    // can force deterministically, so instead we corrupt the hash for a
    // known-valid plaintext and confirm auth now fails.
    const account = await seedAccount();
    const { plaintext, credential } = await createCollectorToken(prisma, account.id);
    await prisma.apiCredential.update({
      where: { id: credential.id },
      data: { tokenHash: await hashToken('a-completely-different-token') },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/collector/cursor/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never logs the plaintext token, even when a request is rejected', async () => {
    const account = await seedAccount();
    const plaintext = 'tm_col_this_exact_secret_must_never_appear_in_any_log_line';
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);

    await request(app, {
      method: 'GET',
      url: `/collector/cursor/${account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });

    const loggedText = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
    expect(loggedText).not.toContain(plaintext);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
