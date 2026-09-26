import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

vi.mock('../../src/auth/token.util', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/auth/token.util')>();
  return { ...real, verifyToken: vi.fn(real.verifyToken) };
});

import { verifyToken, generateCollectorToken, generateDashboardToken, hashToken } from '../../src/auth/token.util';
import { CollectorTokenGuard } from '../../src/auth/collector-token.guard';
import { DashboardTokenGuard } from '../../src/auth/dashboard-token.guard';
import { dashboardTokenCache, tokenDigest } from '../../src/auth/token-auth-cache';
import { isWellFormedToken } from '../../src/auth/token-format';
import {
  AUTH_FAILURE_LIMIT,
  Argon2Gate,
  AuthFailureLimiter,
  authFailureLimiter,
  clientKey,
} from '../../src/auth/auth-throttle';

const prisma = new PrismaClient();
const verifySpy = vi.mocked(verifyToken);

interface Sent {
  headers: Record<string, string>;
}

function ctx(authorization: string | undefined, opts: { accountId?: string; client?: string } = {}): { context: ExecutionContext; sent: Sent } {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (opts.client) headers['x-forwarded-for'] = opts.client;
  const request = { headers, params: opts.accountId ? { accountId: opts.accountId } : {}, body: undefined, ip: '172.20.0.9' };
  const sent: Sent = { headers: {} };
  const reply = { header: (k: string, v: string) => { sent.headers[k] = v; } };
  const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }) } as unknown as ExecutionContext;
  return { context, sent };
}

let accountA: string;
let accountB: string;
let collectorA: { plaintext: string; id: string };
let dashboardA: { plaintext: string; id: string };

async function mint(accountId: string, scope: 'collector' | 'dashboard'): Promise<{ plaintext: string; id: string }> {
  const t = scope === 'collector' ? generateCollectorToken() : generateDashboardToken();
  const row = await prisma.apiCredential.create({
    data: { accountId, scope, tokenPrefix: t.prefix, tokenHash: await hashToken(t.plaintext), name: 'test' },
  });
  return { plaintext: t.plaintext, id: row.id };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  accountA = (await createTradingAccount(prisma, user.id)).id;
  accountB = (await createTradingAccount(prisma, user.id)).id;
  collectorA = await mint(accountA, 'collector');
  dashboardA = await mint(accountA, 'dashboard');
  verifySpy.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const collector = () => new CollectorTokenGuard(prisma as never);
const dashboard = () => new DashboardTokenGuard(prisma as never);

/** A prisma stand-in that records every call, for proving that nothing was looked up. */
function recordingPrisma() {
  const calls: string[] = [];
  const p = {
    apiCredential: {
      findMany: (a: never) => { calls.push('findMany'); return prisma.apiCredential.findMany(a); },
      findFirst: (a: never) => { calls.push('findFirst'); return prisma.apiCredential.findFirst(a); },
      update: (a: never) => { calls.push('update'); return prisma.apiCredential.update(a); },
    },
  };
  return { p, calls };
}

describe('token shape', () => {
  it('minted tokens are well formed for their own scope only', () => {
    const c = generateCollectorToken().plaintext;
    const d = generateDashboardToken().plaintext;
    expect(isWellFormedToken('collector', c)).toBe(true);
    expect(isWellFormedToken('dashboard', d)).toBe(true);
    expect(isWellFormedToken('dashboard', c)).toBe(false);
    expect(isWellFormedToken('collector', d)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['wrong prefix', 'tm_xyz_' + 'a'.repeat(43)],
    ['too short', 'tm_col_' + 'a'.repeat(42)],
    ['too long', 'tm_col_' + 'a'.repeat(44)],
    ['bad characters', 'tm_col_' + 'a'.repeat(42) + '!'],
    ['padding', 'tm_col_' + 'a'.repeat(42) + '='],
    ['whitespace inside', 'tm_col_' + 'a'.repeat(21) + ' ' + 'a'.repeat(21)],
  ])('rejects %s', (_label, token) => {
    expect(isWellFormedToken('collector', token)).toBe(false);
  });
});

describe('cheap rejection before any lookup or Argon2', () => {
  it.each([
    ['missing Authorization', undefined, 'Missing bearer token'],
    ['wrong scheme', 'Basic abc', 'Missing bearer token'],
    ['malformed token', 'Bearer tm_col_short', 'Malformed token'],
    ['wrong-scope prefix', 'Bearer tm_dsh_' + 'a'.repeat(43), 'Malformed token'],
  ])('%s → 401 with no database call and no Argon2', async (_label, header, message) => {
    const { p, calls } = recordingPrisma();
    const { context } = ctx(header, { accountId: accountA });
    await expect(new CollectorTokenGuard(p as never).canActivate(context)).rejects.toThrow(new UnauthorizedException(message));
    expect(calls).toEqual([]);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('a well-formed unknown token still goes through lookup and fails', async () => {
    const unknown = collectorA.plaintext.slice(0, 8) + 'Z'.repeat(42);
    await expect(collector().canActivate(ctx(`Bearer ${unknown}`, { accountId: accountA }).context)).rejects.toThrow(
      new UnauthorizedException('Invalid or revoked token'),
    );
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('a collector token is refused by the dashboard guard (and vice versa)', async () => {
    await expect(dashboard().canActivate(ctx(`Bearer ${collectorA.plaintext}`).context)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(collector().canActivate(ctx(`Bearer ${dashboardA.plaintext}`, { accountId: accountA }).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('dashboard token cache', () => {
  it('caches success, keyed by digest, and sets the bound account', async () => {
    for (let i = 0; i < 5; i++) {
      const { context } = ctx(`Bearer ${dashboardA.plaintext}`, { accountId: accountA });
      await expect(dashboard().canActivate(context)).resolves.toBe(true);
    }
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(dashboardTokenCache.hasKey(tokenDigest(dashboardA.plaintext))).toBe(true);
    expect(dashboardTokenCache.hasKey(dashboardA.plaintext)).toBe(false);
  });

  it('account binding holds on a cache hit', async () => {
    await dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`, { accountId: accountA }).context);
    await expect(dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`, { accountId: accountB }).context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('expires after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
      await dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context);
      vi.setSystemTime(new Date('2026-09-26T10:01:01Z'));
      await dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context);
      expect(verifySpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revocation (disable), deletion and rotation take effect despite the cache', async () => {
    await dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context);
    await prisma.apiCredential.update({ where: { id: dashboardA.id }, data: { revokedAt: new Date() } });
    await expect(dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context)).rejects.toBeInstanceOf(UnauthorizedException);

    const second = await mint(accountA, 'dashboard');
    await dashboard().canActivate(ctx(`Bearer ${second.plaintext}`).context);
    await prisma.apiCredential.delete({ where: { id: second.id } });
    await expect(dashboard().canActivate(ctx(`Bearer ${second.plaintext}`).context)).rejects.toBeInstanceOf(UnauthorizedException);

    const third = await mint(accountA, 'dashboard');
    await expect(dashboard().canActivate(ctx(`Bearer ${third.plaintext}`).context)).resolves.toBe(true);
  });

  it('in-process invalidation drops the cached entry', async () => {
    await dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context);
    dashboardTokenCache.invalidateCredential(dashboardA.id);
    expect(dashboardTokenCache.hasKey(tokenDigest(dashboardA.plaintext))).toBe(false);
    await dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context);
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it('concurrent identical requests share one Argon2 verification', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context)),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(dashboardTokenCache.inFlightCount).toBe(0);
  });
});

describe('lastUsedAt', () => {
  it('is throttled to one write per credential per minute', async () => {
    const { p, calls } = recordingPrisma();
    for (let i = 0; i < 10; i++) await new DashboardTokenGuard(p as never).canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context);
    expect(calls.filter((c) => c === 'update')).toHaveLength(1);
  });

  it('a failing write does not fail authentication', async () => {
    const failing = {
      apiCredential: {
        findMany: (a: never) => prisma.apiCredential.findMany(a),
        findFirst: (a: never) => prisma.apiCredential.findFirst(a),
        update: () => Promise.reject(new Error('database unavailable')),
      },
    };
    await expect(new CollectorTokenGuard(failing as never).canActivate(ctx(`Bearer ${collectorA.plaintext}`, { accountId: accountA }).context)).resolves.toBe(true);
    await expect(new DashboardTokenGuard(failing as never).canActivate(ctx(`Bearer ${dashboardA.plaintext}`).context)).resolves.toBe(true);
  });
});

describe('authentication failure rate limit', () => {
  const bad = 'Bearer tm_col_' + 'q'.repeat(43);

  it(`blocks a client with 429 after ${AUTH_FAILURE_LIMIT} failures, before any lookup`, async () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
      await expect(collector().canActivate(ctx(bad, { accountId: accountA, client: '203.0.113.7' }).context)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const { p, calls } = recordingPrisma();
    const { context, sent } = ctx(bad, { accountId: accountA, client: '203.0.113.7' });
    const err = await new CollectorTokenGuard(p as never).canActivate(context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(Number(sent.headers['Retry-After'])).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('a blocked client is refused even with a valid token, until its window ends', async () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
      await collector().canActivate(ctx(bad, { accountId: accountA, client: '203.0.113.8' }).context).catch(() => undefined);
    }
    const err = await collector().canActivate(ctx(`Bearer ${collectorA.plaintext}`, { accountId: accountA, client: '203.0.113.8' }).context).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('other clients, including the legitimate collector, are unaffected', async () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT + 5; i++) {
      await collector().canActivate(ctx(bad, { accountId: accountA, client: '203.0.113.9' }).context).catch(() => undefined);
    }
    await expect(collector().canActivate(ctx(`Bearer ${collectorA.plaintext}`, { accountId: accountA }).context)).resolves.toBe(true);
    await expect(dashboard().canActivate(ctx(`Bearer ${dashboardA.plaintext}`, { client: '198.51.100.1' }).context)).resolves.toBe(true);
  });

  it('successful traffic is never counted', async () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT * 5; i++) {
      await expect(collector().canActivate(ctx(`Bearer ${collectorA.plaintext}`, { accountId: accountA }).context)).resolves.toBe(true);
    }
    expect(authFailureLimiter.size).toBe(0);
  });

  it('the window expires', () => {
    const l = new AuthFailureLimiter(3, 1_000, 100);
    for (let i = 0; i < 3; i++) l.recordFailure('k', 0);
    expect(l.retryAfterSeconds('k', 500)).toBe(1);
    expect(l.retryAfterSeconds('k', 1_000)).toBe(0);
  });

  it('is bounded', () => {
    const l = new AuthFailureLimiter(3, 60_000, 50);
    for (let i = 0; i < 1_000; i++) l.recordFailure(`client-${i}`, 0);
    expect(l.size).toBeLessThanOrEqual(50);
  });

  it('keys by the first X-Forwarded-For entry, else the socket address', () => {
    const r = (headers: Record<string, string>) => ({ headers, ip: '172.18.0.5' }) as never;
    expect(clientKey(r({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }))).toBe('203.0.113.1');
    expect(clientKey(r({}))).toBe('172.18.0.5');
  });
});

describe('Argon2 concurrency gate', () => {
  it('runs at most N tasks at once and refuses beyond the queue', async () => {
    const gate = new Argon2Gate(2, 3);
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const task = () =>
      new Promise<number>((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        releases.push(() => { running -= 1; resolve(1); });
      });
    const runs = Array.from({ length: 6 }, () => gate.run(task));
    const refused = await runs[5];
    expect(refused).toEqual({ ok: false });
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(3);
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    const done = await Promise.all(runs.slice(0, 5));
    expect(done.every((d) => d.ok)).toBe(true);
    expect(peak).toBe(2);
    expect(gate.activeCount).toBe(0);
  });

  it('releases its slot when a task throws', async () => {
    const gate = new Argon2Gate(1, 0);
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.activeCount).toBe(0);
    await expect(gate.run(() => Promise.resolve(7))).resolves.toEqual({ ok: true, value: 7 });
  });
});
