import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { setupAccountWithToken, validPositionPayload, validSnapshotPayload } from './helpers/factories';
import { request } from './helpers/http';

describe('snapshot ingestion', () => {
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

  it('accepts a valid snapshot and persists it', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload = validSnapshotPayload(account.id, { balance: 5000, equity: 4950 });

    const res = await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].balance)).toBe(5000);
    expect(Number(rows[0].equity)).toBe(4950);
  });

  it('persists tradeMode when the collector sends it — the input to the autonomous system\'s demo-account safety check', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload = validSnapshotPayload(account.id, { tradeMode: 'DEMO' });

    await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });

    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows[0].tradeMode).toBe('DEMO');
  });

  it('accepts a snapshot omitting tradeMode (an older collector) and leaves it null, never guessed', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload = validSnapshotPayload(account.id);

    const res = await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });

    expect(res.statusCode).toBe(201);
    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows[0].tradeMode).toBeNull();
  });

  it('rejects a snapshot with an invalid tradeMode value', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload = validSnapshotPayload(account.id, { tradeMode: 'FAKE_MODE' });

    const res = await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });
    expect(res.statusCode).toBe(400);
  });

  it('does not duplicate a snapshot re-sent with the same capturedAt', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const capturedAt = new Date().toISOString();
    const payload = validSnapshotPayload(account.id, { capturedAt });

    await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });
    await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });

    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
  });

  it('rejects a snapshot missing a required field, and persists nothing', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload: any = validSnapshotPayload(account.id);
    delete payload.balance;

    const res = await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload,
    });

    expect(res.statusCode).toBe(400);
    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(0);
  });

  it('rejects a snapshot missing the nested terminal object with a 400, not an unhandled 500 (production readiness review — a bare @ValidateNested() alone skips validation entirely when the property is absent)', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload: any = validSnapshotPayload(account.id);
    delete payload.terminal;

    const res = await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload,
    });

    expect(res.statusCode).toBe(400);
    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(0);
  });

  it('rejects a snapshot containing an unrecognized field', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload = { ...validSnapshotPayload(account.id), notARealField: 'nope' };

    const res = await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a snapshot for an accountId the token is not bound to (including a nonexistent one)', async () => {
    const { token } = await setupAccountWithToken(prisma);
    // Production-readiness review, item 1: CollectorTokenGuard now checks
    // the token's account binding before the request ever reaches the
    // controller, so a mismatched accountId is rejected as 403 regardless
    // of whether that id belongs to a real account — a valid token can no
    // longer be used to even distinguish "wrong account" from "no such
    // account" by probing arbitrary UUIDs. A syntactically valid but
    // unassigned UUID exercises exactly that; class-validator's @IsUUID()
    // would 400 a malformed one before it got this far.
    const payload = validSnapshotPayload(randomUUID());

    const res = await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload,
    });
    expect(res.statusCode).toBe(403);
  });

  it("stamps positions with the account's own platform, not something client-supplied", async () => {
    const { account, token } = await setupAccountWithToken(prisma); // platform defaults to MT5
    const payload = validSnapshotPayload(account.id, { positions: [validPositionPayload()] });

    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload,
    });

    const positions = await prisma.position.findMany({ where: { accountId: account.id } });
    expect(positions).toHaveLength(1);
    expect(positions[0].platform).toBe('MT5');
  });

  // Gold collection alongside EURUSD — one quote per configured symbol
  // (collector/app/api_mapper.py's `liveTicks`), landing in the same
  // symbol-keyed LiveTick table `liveTick` (single-symbol, kept for
  // existing consumers) already writes to.
  it('upserts one LiveTick row per symbol from liveTicks[]', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const payload = validSnapshotPayload(account.id, {
      liveTicks: [
        { symbol: 'EURUSD', bid: 1.1, ask: 1.1005, tickAt: new Date().toISOString() },
        { symbol: 'XAUUSD', bid: 2500.1, ask: 2500.5, tickAt: new Date().toISOString() },
      ],
    });

    const res = await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });

    expect(res.statusCode).toBe(201);
    const eur = await prisma.liveTick.findUnique({ where: { symbol: 'EURUSD' } });
    const gold = await prisma.liveTick.findUnique({ where: { symbol: 'XAUUSD' } });
    expect(Number(eur?.bid)).toBe(1.1);
    expect(Number(gold?.bid)).toBe(2500.1);
  });

  it('a symbol present in both liveTick and liveTicks is upserted once, not twice, for the same value', async () => {
    // LiveTick is a shared, symbol-keyed table (not account-scoped, not reset between
    // tests — same posture as HistoricalCandle) — a unique symbol isolates this test.
    const { account, token } = await setupAccountWithToken(prisma);
    const symbol = `TEST${randomUUID().slice(0, 8).toUpperCase()}`;
    const tickAt = new Date().toISOString();
    const payload = validSnapshotPayload(account.id, {
      liveTick: { symbol, bid: 1.2, ask: 1.2005, tickAt },
      liveTicks: [{ symbol, bid: 1.2, ask: 1.2005, tickAt }],
    });

    const res = await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });

    expect(res.statusCode).toBe(201);
    expect(await prisma.liveTick.count({ where: { symbol } })).toBe(1);
  });

  it('a snapshot with no liveTick/liveTicks at all still succeeds (existing EURUSD-only deployments unaffected)', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const before = await prisma.liveTick.count();
    const payload = validSnapshotPayload(account.id);

    const res = await request(app, { method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` }, payload });

    expect(res.statusCode).toBe(201);
    expect(await prisma.liveTick.count()).toBe(before); // no row created
  });
});
