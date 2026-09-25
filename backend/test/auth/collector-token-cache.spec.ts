import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

vi.mock('../../src/auth/token.util', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/auth/token.util')>();
  return { ...real, verifyToken: vi.fn(real.verifyToken) };
});

import { verifyToken, generateCollectorToken, hashToken } from '../../src/auth/token.util';
import { CollectorTokenGuard } from '../../src/auth/collector-token.guard';
import { CollectorTokenCache, collectorTokenCache, tokenDigest } from '../../src/auth/collector-token-cache';

const prisma = new PrismaClient();
const verifySpy = vi.mocked(verifyToken);

function ctx(token: string, accountId?: string): ExecutionContext {
  const request = { headers: { authorization: `Bearer ${token}` }, params: accountId ? { accountId } : {}, body: undefined };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

let accountA: string;
let accountB: string;
let tokenA: string;
let credA: string;

async function mintToken(accountId: string): Promise<{ plaintext: string; id: string }> {
  const t = generateCollectorToken();
  const row = await prisma.apiCredential.create({
    data: { accountId, scope: 'collector', tokenPrefix: t.prefix, tokenHash: await hashToken(t.plaintext), name: 'test' },
  });
  return { plaintext: t.plaintext, id: row.id };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  collectorTokenCache.clear();
  const user = await createUser(prisma);
  accountA = (await createTradingAccount(prisma, user.id)).id;
  accountB = (await createTradingAccount(prisma, user.id)).id;
  const minted = await mintToken(accountA);
  tokenA = minted.plaintext;
  credA = minted.id;
  verifySpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const guard = () => new CollectorTokenGuard(prisma as never);

describe('collector token authentication with the verification cache', () => {
  it('1+4: a valid token authenticates, and the first request runs Argon2', async () => {
    await expect(guard().canActivate(ctx(tokenA, accountA))).resolves.toBe(true);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('2: an invalid token is rejected exactly as before', async () => {
    const bogus = tokenA.slice(0, 8) + 'x'.repeat(40);
    await expect(guard().canActivate(ctx(bogus, accountA))).rejects.toThrow(new UnauthorizedException('Invalid or revoked token'));
  });

  it('3: a token for account A is refused for account B', async () => {
    await expect(guard().canActivate(ctx(tokenA, accountB))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('5: repeated requests within the TTL do not run Argon2 again', async () => {
    for (let i = 0; i < 5; i++) await guard().canActivate(ctx(tokenA, accountA));
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('6: after the TTL expires, Argon2 runs again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
    await guard().canActivate(ctx(tokenA, accountA));
    vi.setSystemTime(new Date('2026-09-26T10:01:01Z'));
    await guard().canActivate(ctx(tokenA, accountA));
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it('7: revocation (by another process, straight in the DB) takes effect on the next request despite the cache', async () => {
    await guard().canActivate(ctx(tokenA, accountA));
    await prisma.apiCredential.update({ where: { id: credA }, data: { revokedAt: new Date() } });
    await expect(guard().canActivate(ctx(tokenA, accountA))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('8: rotation (old revoked, new minted) rejects the old token and accepts the new one', async () => {
    await guard().canActivate(ctx(tokenA, accountA));
    await prisma.apiCredential.updateMany({ where: { accountId: accountA, scope: 'collector', revokedAt: null }, data: { revokedAt: new Date() } });
    const fresh = await mintToken(accountA);
    await expect(guard().canActivate(ctx(tokenA, accountA))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard().canActivate(ctx(fresh.plaintext, accountA))).resolves.toBe(true);
  });

  it('8b: deleting the credential rejects a cached token', async () => {
    await guard().canActivate(ctx(tokenA, accountA));
    await prisma.apiCredential.delete({ where: { id: credA } });
    await expect(guard().canActivate(ctx(tokenA, accountA))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('9: account isolation still holds on a cache hit', async () => {
    await guard().canActivate(ctx(tokenA, accountA));
    await expect(guard().canActivate(ctx(tokenA, accountB))).rejects.toBeInstanceOf(ForbiddenException);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('10: the raw token is not used as a cache key', async () => {
    await guard().canActivate(ctx(tokenA, accountA));
    expect(collectorTokenCache.hasKey(tokenA)).toBe(false);
    expect(collectorTokenCache.hasKey(tokenDigest(tokenA))).toBe(true);
  });

  it('11: lastUsedAt is written at most once per minute', async () => {
    let writes = 0;
    const counting = {
      apiCredential: {
        findMany: (a: never) => prisma.apiCredential.findMany(a),
        findFirst: (a: never) => prisma.apiCredential.findFirst(a),
        update: (a: never) => { writes += 1; return prisma.apiCredential.update(a); },
      },
    };
    const g = new CollectorTokenGuard(counting as never);
    for (let i = 0; i < 10; i++) await g.canActivate(ctx(tokenA, accountA));
    expect(writes).toBe(1);
  });

  it('12: concurrent requests after a miss share one Argon2 verification', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => guard().canActivate(ctx(tokenA, accountA))));
    expect(results.every(Boolean)).toBe(true);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('13+14: a failed verification is not cached and its in-flight slot is released', async () => {
    const bogus = tokenA.slice(0, 8) + 'y'.repeat(40);
    await Promise.allSettled(Array.from({ length: 4 }, () => guard().canActivate(ctx(bogus, accountA))));
    expect(collectorTokenCache.hasKey(tokenDigest(bogus))).toBe(false);
    expect(collectorTokenCache.inFlightCount).toBe(0);
    await expect(guard().canActivate(ctx(bogus, accountA))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('14b: a verification that throws releases its in-flight slot', async () => {
    verifySpy.mockRejectedValueOnce(new Error('argon2 failure'));
    await expect(guard().canActivate(ctx(tokenA, accountA))).rejects.toThrow('argon2 failure');
    expect(collectorTokenCache.inFlightCount).toBe(0);
    await expect(guard().canActivate(ctx(tokenA, accountA))).resolves.toBe(true);
  });
});

describe('the cache structure itself', () => {
  it('15: is bounded', () => {
    const c = new CollectorTokenCache(60_000, 10);
    for (let i = 0; i < 100; i++) c.set(`d${i}`, { credentialId: `c${i}`, accountId: 'a' }, 0);
    expect(c.size).toBeLessThanOrEqual(10);
  });

  it('expired entries never authenticate', () => {
    const c = new CollectorTokenCache(60_000, 10);
    c.set('d', { credentialId: 'c', accountId: 'a' }, 0);
    expect(c.get('d', 59_999)).not.toBeNull();
    expect(c.get('d', 60_000)).toBeNull();
  });

  it('invalidateCredential drops every entry for that credential', () => {
    const c = new CollectorTokenCache(60_000, 10);
    c.set('d1', { credentialId: 'c', accountId: 'a' }, 0);
    c.set('d2', { credentialId: 'c', accountId: 'a' }, 0);
    c.invalidateCredential('c');
    expect(c.size).toBe(0);
  });
});
