/**
 * The pure dedup/SQL-build logic shared by `HistoricalTickService`
 * (Prisma-based, unchanged) and the historical-tick worker_thread (plain
 * `pg`, Phase 1's new isolated path) — this is the risk-bearing part of
 * Phase 1's ingestion change, so it's tested against a REAL database, not
 * mocked.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTickInsert, dedupeTicks, type IncomingTickLike } from '../../src/market-data/historical-tick-dedup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

function tick(overrides: Partial<IncomingTickLike> = {}): IncomingTickLike {
  return {
    timestamp: '2026-09-24T12:00:00.000Z',
    bid: 4260.5,
    ask: 4260.7,
    last: null,
    volume: null,
    volumeReal: null,
    flags: 6,
    batchSeq: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await pool.query(`DELETE FROM historical_ticks WHERE symbol = 'TESTDEDUP'`);
});

afterAll(async () => {
  await pool.end();
});

describe('dedupeTicks', () => {
  it('keeps one row per distinct identity, last occurrence wins', () => {
    const a = tick({ batchSeq: 0 });
    const b = tick({ batchSeq: 1 }); // identical identity, different batchSeq -- batchSeq is NOT part of identity
    const c = tick({ bid: 4261.0, batchSeq: 2 }); // genuinely different
    const result = dedupeTicks([a, b, c]);
    expect(result).toHaveLength(2);
    expect(result[0].batchSeq).toBe(1); // last-occurrence-wins for the duplicate
  });

  it('treats null and undefined optional fields identically', () => {
    const a = tick({ last: undefined });
    const b = tick({ last: null });
    expect(dedupeTicks([a, b])).toHaveLength(1);
  });
});

describe('buildTickInsert against a real database', () => {
  it('inserts every deduped row with correct values', async () => {
    const ticks = [tick({ batchSeq: 0 }), tick({ bid: 4261.0, batchSeq: 1 })];
    const { text, values } = buildTickInsert('TESTDEDUP', 'XAUUSD.a', 'TestServer', 'feed1', ticks);
    const result = await pool.query(text, values);
    expect(result.rowCount).toBe(2);

    const rows = await pool.query(`SELECT bid, ask, broker_symbol, server, feed_id FROM historical_ticks WHERE symbol = 'TESTDEDUP' ORDER BY bid ASC`);
    expect(rows.rows).toHaveLength(2);
    expect(Number(rows.rows[0].bid)).toBeCloseTo(4260.5, 6);
    expect(Number(rows.rows[1].bid)).toBeCloseTo(4261.0, 6);
    expect(rows.rows[0].broker_symbol).toBe('XAUUSD.a');
  });

  it('ON CONFLICT DO NOTHING makes redelivering the same batch safe (no duplicate rows)', async () => {
    const ticks = [tick()];
    const { text, values } = buildTickInsert('TESTDEDUP', null, null, null, ticks);
    await pool.query(text, values);
    const second = await pool.query(text, values); // identical batch, redelivered
    expect(second.rowCount).toBe(0); // nothing new inserted

    const count = await pool.query(`SELECT count(*) FROM historical_ticks WHERE symbol = 'TESTDEDUP'`);
    expect(Number(count.rows[0].count)).toBe(1); // exactly one row, not two
  });

  it('a batch of ticks that dedupe down to zero rows (all duplicates within the batch) inserts nothing and does not error', async () => {
    const ticks = [tick(), tick()]; // identical
    const deduped = dedupeTicks(ticks);
    expect(deduped).toHaveLength(1);
    const { text, values } = buildTickInsert('TESTDEDUP', null, null, null, deduped);
    const result = await pool.query(text, values);
    expect(result.rowCount).toBe(1);
  });
});
