// End-to-end Phase 8 tests: real Postgres, real HTTP layer (Fastify inject),
// no mocks needed — the importer talks to nothing external. Mirrors the
// health-e2e.spec.ts pattern: createTestApp() + request() against the real
// AppModule graph.
import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';

const HEADER = 'Order,Symbol,Type,Volume,Open Time,Open Price,Close Time,Close Price,Commission,Swap,Profit,Comment';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('Phase 8 — XTB CSV import (end-to-end)', () => {
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

  async function xtbAccount() {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id, { platform: 'XTB' });
    const { plaintext: token } = await createDashboardToken(prisma, account.id);
    return { ...account, token };
  }

  it('rejects an import for a non-XTB account', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id, { platform: 'MT5' });
    const { plaintext: token } = await createDashboardToken(prisma, account.id);
    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${token}` },
      payload: { accountId: account.id, csvContent: `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('imports one closed-position row as a synthetic IN/OUT Trade pair, preserving raw payload', async () => {
    const account = await xtbAccount();
    const csvContent = `${HEADER}\n555,EURUSD,BUY,0.5,2026-01-01 10:00:00,1.1000,2026-01-01 11:00:00,1.1050,-2,0.5,25,note`;

    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, fileName: 'export.csv', csvContent },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.rowsImported).toBe(1);
    expect(res.body.rowsSkipped).toBe(0);

    const trades = await prisma.trade.findMany({
      where: { accountId: account.id },
      orderBy: { dealEntry: 'asc' },
    });
    expect(trades).toHaveLength(2);
    const [inTrade, outTrade] = trades;
    expect(inTrade.dealEntry).toBe('IN');
    expect(inTrade.externalTradeId).toBe('555-IN');
    expect(Number(inTrade.price)).toBe(1.1);
    expect(outTrade.dealEntry).toBe('OUT');
    expect(outTrade.externalTradeId).toBe('555-OUT');
    expect(Number(outTrade.price)).toBe(1.105);
    expect(Number(outTrade.profit)).toBe(25);
    expect((outTrade.rawPayload as Record<string, string>).Symbol).toBe('EURUSD');
  });

  it('whole-file dedup: re-uploading the identical file is a no-op, not a re-import', async () => {
    const account = await xtbAccount();
    const csvContent = `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,`;

    const first = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent },
    });
    const second = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent },
    });

    expect(first.body.id).toBe(second.body.id);
    const batches = await prisma.importBatch.findMany({ where: { accountId: account.id } });
    expect(batches).toHaveLength(1);
    const trades = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(trades).toHaveLength(2); // not 4
  });

  it('row-level dedup: the same order id appearing in a second, different file is skipped, not double-imported', async () => {
    const account = await xtbAccount();
    const first = `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,first file`;
    const second = `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,second file\n2,GBPUSD,SELL,1,2026-01-03,1.3,2026-01-04,1.29,,,5,`;

    await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent: first },
    });
    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent: second },
    });

    expect(res.body.rowsImported).toBe(1); // only order 2 is new
    expect(res.body.rowsSkipped).toBe(1); // order 1 already imported
    const trades = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(trades).toHaveLength(4); // 2 pairs, not 3
  });

  // Audit finding: the existing row-level dedup test above overlaps two
  // files on the SAME order id with IDENTICAL values, which only proves a
  // pure duplicate is skipped — it says nothing about what happens when a
  // broker re-export CORRECTS a previously-imported row (e.g. a late swap
  // adjustment changes the recorded profit). This test makes that behavior
  // explicit rather than leaving it undocumented: dedup keys ONLY on
  // (accountId, platform, externalTradeId) — a second row under the same id
  // is skipped regardless of whether its OTHER fields differ, so a
  // correction from the broker is silently NOT applied. This is a real,
  // current limitation (no update-on-reimport path exists anywhere in this
  // module), not a hidden bug — documented here so it can't be assumed away.
  it('an overlapping export with a CORRECTED value for an already-imported order id keeps the ORIGINAL value, not the correction', async () => {
    const account = await xtbAccount();
    const original = `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,0,0,10,original`;
    // Same order id 1, but the broker "corrected" profit from 10 to -50
    // (e.g. a late swap/commission adjustment) — plus one genuinely new row.
    const correctedReExport = `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,0,0,-50,corrected\n2,GBPUSD,SELL,1,2026-01-03,1.3,2026-01-04,1.29,0,0,5,`;

    await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent: original },
    });
    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent: correctedReExport },
    });

    expect(res.body.rowsImported).toBe(1); // only order 2
    expect(res.body.rowsSkipped).toBe(1); // order 1's "correction" is skipped, not applied

    const outLeg = await prisma.trade.findFirst({ where: { accountId: account.id, externalTradeId: '1-OUT' } });
    expect(outLeg?.profit.toNumber()).toBe(10); // ORIGINAL value retained — the correction never lands
    expect((outLeg?.rawPayload as Record<string, string>).Comment).toBe('original');
  });

  it('resumes a PENDING batch left over from an interrupted attempt instead of treating it as done', async () => {
    const account = await xtbAccount();
    const csvContent = `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,`;
    const pending = await prisma.importBatch.create({
      data: { accountId: account.id, fileSha256: sha256(csvContent), status: 'PENDING' },
    });

    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent },
    });

    expect(res.body.id).toBe(pending.id);
    expect(res.body.status).toBe('COMPLETED');
    const trades = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(trades).toHaveLength(2);
  });

  it('resumes a FAILED batch by re-uploading the identical file', async () => {
    const account = await xtbAccount();
    const csvContent = `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,`;
    const failed = await prisma.importBatch.create({
      data: { accountId: account.id, fileSha256: sha256(csvContent), status: 'FAILED', error: 'previous crash' },
    });

    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent },
    });

    expect(res.body.id).toBe(failed.id);
    expect(res.body.status).toBe('COMPLETED');
  });

  it('a file with only unparseable rows marks the batch FAILED with no trades written', async () => {
    const account = await xtbAccount();
    const csvContent = `${HEADER}\n1,EURUSD,SIDEWAYS,1,2026-01-01,1.1,2026-01-02,1.2,,,10,bad side`;

    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent },
    });

    expect(res.body.status).toBe('FAILED');
    const trades = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(trades).toHaveLength(0);
  });

  it('GET /xtb-import/batches/:accountId lists batches newest first', async () => {
    const account = await xtbAccount();
    await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent: `${HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,` },
    });
    await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent: `${HEADER}\n2,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,` },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/xtb-import/batches/${account.id}`,
      headers: { authorization: `Bearer ${account.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
