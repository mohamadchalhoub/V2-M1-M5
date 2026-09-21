// End-to-end tests for the .xlsx import path added during the historical
// chart reconstruction phase — same createTestApp()/request() pattern as
// xtb-import-e2e.spec.ts's CSV coverage, but posting a real in-memory xlsx
// workbook (built with ExcelJS, shaped like the real XTB/xStation5 export
// this phase was verified against) as base64 instead of CSV text.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';

const REAL_HEADER = [
  'Position', 'Symbol', 'Type', 'Volume', 'Open time', 'Open price', 'Close time', 'Close price',
  'Open origin', 'Close origin', 'Purchase value', 'Sale value', 'SL', 'TP', 'Margin',
  'Commission', 'Swap', 'Rollover', 'Gross P/L', 'Comment',
];

async function buildXlsxBase64(dataRows: (string | number | Date)[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('CLOSED POSITION HISTORY');
  for (let r = 1; r < 13; r++) sheet.addRow([]);
  sheet.addRow(REAL_HEADER);
  for (const row of dataRows) sheet.addRow(row);
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

function row(orderId: number, profit: number, comment = ''): (string | number | Date)[] {
  return [
    orderId, 'EURUSD', 'BUY', 0.1,
    new Date('2026-01-01T00:00:00Z'), 1.1,
    new Date('2026-01-01T01:00:00Z'), 1.11,
    '', '', '', '', '', '', 0, 0, 0, 0, profit, comment,
  ];
}

describe('XTB xlsx import (end-to-end)', () => {
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

  it('imports a real-shaped xlsx export as a synthetic IN/OUT Trade pair', async () => {
    const account = await xtbAccount();
    const xlsxContentBase64 = await buildXlsxBase64([row(555, 25, 'note')]);

    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, fileName: 'export.xlsx', xlsxContentBase64 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.rowsImported).toBe(1);

    const trades = await prisma.trade.findMany({ where: { accountId: account.id }, orderBy: { dealEntry: 'asc' } });
    expect(trades).toHaveLength(2);
    expect(trades[0].externalTradeId).toBe('555-IN');
    expect(trades[1].externalTradeId).toBe('555-OUT');
    expect(Number(trades[1].profit)).toBe(25);
  });

  it('persists stop-loss/take-profit onto both trade legs when present in the source row', async () => {
    const account = await xtbAccount();
    const rowWithSlTp: (string | number | Date)[] = [
      1211940652, 'EURUSD', 'SELL', 0.07,
      new Date('2024-02-01T08:44:18.161Z'), 1.0785,
      new Date('2024-02-01T08:55:15.067Z'), 1.07925,
      'xStation Mobile iOS', 'pending(t/p|s/l)', '', '',
      1.07925, 1.077, // SL, TP
      233.1, 0, 0, 0, -4.86, '[S/L]',
    ];
    const xlsxContentBase64 = await buildXlsxBase64([rowWithSlTp]);

    await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, xlsxContentBase64 },
    });

    const trades = await prisma.trade.findMany({ where: { accountId: account.id }, orderBy: { dealEntry: 'asc' } });
    expect(trades).toHaveLength(2);
    for (const trade of trades) {
      expect(Number(trade.stopLoss)).toBe(1.07925);
      expect(Number(trade.takeProfit)).toBe(1.077);
    }
  });

  it('whole-file dedup works identically for xlsx as for csv', async () => {
    const account = await xtbAccount();
    const xlsxContentBase64 = await buildXlsxBase64([row(1, 10)]);

    const first = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, xlsxContentBase64 },
    });
    const second = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, xlsxContentBase64 },
    });

    expect(first.body.id).toBe(second.body.id);
    const trades = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(trades).toHaveLength(2); // not 4
  });

  it('rejects a request providing both csvContent and xlsxContentBase64', async () => {
    const account = await xtbAccount();
    const xlsxContentBase64 = await buildXlsxBase64([row(1, 10)]);
    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, csvContent: 'a,b\n1,2', xlsxContentBase64 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request providing neither csvContent nor xlsxContentBase64', async () => {
    const account = await xtbAccount();
    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a workbook with no recognizable closed-positions sheet marks the batch FAILED', async () => {
    const account = await xtbAccount();
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('CASH OPERATION HISTORY');
    sheet.addRow(['Date', 'Type', 'Amount']);
    const xlsxContentBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    const res = await request(app, {
      method: 'POST',
      url: '/xtb-import',
      headers: { authorization: `Bearer ${account.token}` },
      payload: { accountId: account.id, xlsxContentBase64 },
    });
    expect(res.body.status).toBe('FAILED');
  });
});
