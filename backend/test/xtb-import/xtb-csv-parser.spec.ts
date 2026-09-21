import { describe, expect, it } from 'vitest';
import { parseXtbClosedPositionsCsv } from '../../src/xtb-import/xtb-csv-parser';

const HEADER = 'Order,Symbol,Type,Volume,Open Time,Open Price,Close Time,Close Price,SL,TP,Commission,Swap,Profit,Comment';

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('parseXtbClosedPositionsCsv', () => {
  it('parses a well-formed row into a normalized XtbClosedPositionRow', () => {
    const { rows, errors } = parseXtbClosedPositionsCsv(
      csv('12345,EURUSD,BUY,0.5,2026-01-01 10:00:00,1.1000,2026-01-01 11:00:00,1.1050,1.0900,1.1100,-2,0.5,25,test trade'),
    );

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderId: '12345',
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.5,
      openPrice: 1.1,
      closePrice: 1.105,
      stopLoss: 1.09,
      takeProfit: 1.11,
      commission: -2,
      swap: 0.5,
      profit: 25,
      comment: 'test trade',
    });
    expect(rows[0].openTime).toBeInstanceOf(Date);
    expect(rows[0].closeTime).toBeInstanceOf(Date);
    expect(rows[0].raw).toMatchObject({ Order: '12345', Symbol: 'EURUSD' });
  });

  it('recognizes alternate column-name spellings and casing', () => {
    const header = 'position,instrument,direction,lots,openDate,priceOpen,closeDate,priceClose,netpl';
    const { rows, errors } = parseXtbClosedPositionsCsv(
      [header, '999,GBPUSD,SELL,1,2026-02-01,1.25,2026-02-02,1.24,10'].join('\n'),
    );
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orderId: '999', symbol: 'GBPUSD', side: 'SELL', profit: 10 });
    expect(rows[0].commission).toBe(0); // column absent → default
    expect(rows[0].stopLoss).toBeNull();
  });

  it('maps B/S single-letter side values', () => {
    const { rows } = parseXtbClosedPositionsCsv(
      csv('1,EURUSD,B,1,2026-01-01,1.1,2026-01-02,1.2,,,,,,'),
    );
    expect(rows[0].side).toBe('BUY');
  });

  it('returns a single missing-columns error and no rows when required columns are absent', () => {
    const { rows, errors } = parseXtbClosedPositionsCsv('Foo,Bar\n1,2');
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/missing required column/i);
  });

  it('collects per-row errors for unparseable rows without discarding valid ones', () => {
    const { rows, errors } = parseXtbClosedPositionsCsv(
      csv(
        '1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,,,10,ok',
        '2,EURUSD,SIDEWAYS,1,2026-01-01,1.1,2026-01-02,1.2,,,,,10,bad side',
        ',EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,,,10,missing id',
        '4,EURUSD,BUY,1,not-a-date,1.1,2026-01-02,1.2,,,,,10,bad open time',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe('1');
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.message).join('|')).toMatch(/unrecognized side/);
    expect(errors.map((e) => e.message).join('|')).toMatch(/missing order\/position id/);
    expect(errors.map((e) => e.message).join('|')).toMatch(/unparseable open time/);
  });

  it('handles thousands separators in numeric fields', () => {
    const { rows } = parseXtbClosedPositionsCsv(
      csv('1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,,,"1,250.75",ok'),
    );
    expect(rows[0].profit).toBe(1250.75);
  });

  it('returns empty rows/errors for an empty file', () => {
    const { rows, errors } = parseXtbClosedPositionsCsv('');
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('preserves the exact original cell values in raw for both rows', () => {
    const { rows } = parseXtbClosedPositionsCsv(
      csv('1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,,,10,ok'),
    );
    expect(rows[0].raw['Symbol']).toBe('EURUSD');
    expect(rows[0].raw['Profit']).toBe('10');
  });
});
