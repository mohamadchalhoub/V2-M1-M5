import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseXtbClosedPositionsXlsx } from '../../src/xtb-import/xtb-csv-parser';

const REAL_HEADER = [
  'Position',
  'Symbol',
  'Type',
  'Volume',
  'Open time',
  'Open price',
  'Close time',
  'Close price',
  'Open origin',
  'Close origin',
  'Purchase value',
  'Sale value',
  'SL',
  'TP',
  'Margin',
  'Commission',
  'Swap',
  'Rollover',
  'Gross P/L',
  'Comment',
];

/**
 * Mirrors the real XTB/xStation5 "closed positions" export's report shape
 * (verified against a real file): several title/summary rows before the
 * real header (here: 12 blank-ish rows, header at row 13, same as the real
 * export), plus other, irrelevant report sheets in the same workbook.
 */
async function buildWorkbook(dataRows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const openPositions = wb.addWorksheet('OPEN POSITION 25082026');
  openPositions.addRow(['unrelated', 'sheet']);

  const sheet = wb.addWorksheet('CLOSED POSITION HISTORY');
  for (let r = 1; r < 13; r++) sheet.addRow([]); // title/summary block, same offset as the real file
  sheet.addRow(REAL_HEADER);
  for (const row of dataRows) sheet.addRow(row);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('parseXtbClosedPositionsXlsx', () => {
  it('finds the real header row (13) after title/summary rows and parses a well-formed row', async () => {
    const buffer = await buildWorkbook([
      [
        1211917053,
        'EURUSD',
        'SELL',
        0.01,
        new Date('2024-02-01T08:18:33.058Z'),
        1.07868,
        new Date('2024-02-01T08:21:00.536Z'),
        1.07865,
        'xStation Mobile iOS',
        'xStation Mobile iOS',
        '',
        '',
        '',
        '',
        33.3,
        0,
        0,
        0,
        0.03,
        '',
      ],
    ]);

    const { rows, errors } = await parseXtbClosedPositionsXlsx(buffer);
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderId: '1211917053',
      symbol: 'EURUSD',
      side: 'SELL',
      volume: 0.01,
      openPrice: 1.07868,
      closePrice: 1.07865,
      commission: 0,
      swap: 0,
      profit: 0.03,
      stopLoss: null,
      takeProfit: null,
    });
    expect(rows[0].openTime.toISOString()).toBe('2024-02-01T08:18:33.058Z');
    expect(rows[0].closeTime.toISOString()).toBe('2024-02-01T08:21:00.536Z');
  });

  it('parses SL/TP when present, matching a real stop-out row', async () => {
    const buffer = await buildWorkbook([
      [
        1211940652,
        'EURUSD',
        'SELL',
        0.07,
        new Date('2024-02-01T08:44:18.161Z'),
        1.0785,
        new Date('2024-02-01T08:55:15.067Z'),
        1.07925,
        'xStation Mobile iOS',
        'pending(t/p|s/l)',
        '',
        '',
        1.07925,
        1.077,
        233.1,
        0,
        0,
        0,
        -4.86,
        '[S/L]',
      ],
    ]);

    const { rows, errors } = await parseXtbClosedPositionsXlsx(buffer);
    expect(errors).toHaveLength(0);
    expect(rows[0]).toMatchObject({ stopLoss: 1.07925, takeProfit: 1.077, profit: -4.86, comment: '[S/L]' });
  });

  it('handles multiple rows, skipping blank spacer rows rather than stopping at the first one', async () => {
    const buffer = await buildWorkbook([
      [1, 'EURUSD', 'BUY', 0.1, new Date('2026-01-01T00:00:00Z'), 1.1, new Date('2026-01-01T01:00:00Z'), 1.11, '', '', '', '', '', '', 0, 0, 0, 0, 10, ''],
      [],
      [2, 'EURUSD', 'SELL', 0.2, new Date('2026-01-02T00:00:00Z'), 1.12, new Date('2026-01-02T01:00:00Z'), 1.1, '', '', '', '', '', '', 0, 0, 0, 0, 40, ''],
    ]);

    const { rows, errors } = await parseXtbClosedPositionsXlsx(buffer);
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.orderId)).toEqual(['1', '2']);
  });

  it('preserves the exact original cell values in raw, ISO-stringified for dates', async () => {
    const buffer = await buildWorkbook([
      [7, 'EURUSD', 'BUY', 1, new Date('2026-01-01T00:00:00Z'), 1.1, new Date('2026-01-02T00:00:00Z'), 1.2, '', '', '', '', '', '', 0, 0, 0, 0, 10, 'note'],
    ]);
    const { rows } = await parseXtbClosedPositionsXlsx(buffer);
    expect(rows[0].raw['Symbol']).toBe('EURUSD');
    expect(rows[0].raw['Open time']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns an error when no sheet has a recognizable closed-positions header', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('CASH OPERATION HISTORY');
    sheet.addRow(['Date', 'Type', 'Amount']);
    sheet.addRow(['2026-01-01', 'deposit', '100']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const { rows, errors } = await parseXtbClosedPositionsXlsx(buffer);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/no sheet/i);
  });

  it('ignores other sheets in the same workbook (open positions, pending orders)', async () => {
    const buffer = await buildWorkbook([
      [1, 'EURUSD', 'BUY', 0.1, new Date('2026-01-01T00:00:00Z'), 1.1, new Date('2026-01-01T01:00:00Z'), 1.11, '', '', '', '', '', '', 0, 0, 0, 0, 10, ''],
    ]);
    const { rows } = await parseXtbClosedPositionsXlsx(buffer);
    expect(rows).toHaveLength(1); // the unrelated "OPEN POSITION" sheet's row never leaks in
  });
});
