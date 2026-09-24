/**
 * The dedup key and INSERT statement for `historical_ticks`, extracted as
 * PURE functions with zero Prisma/Nest dependency -- deliberately, so the
 * historical-tick worker_thread (which cannot use NestJS DI or a second
 * PrismaClient without real cost, see historical-tick-worker-thread.ts's
 * own docstring) can share the exact same identity/dedup logic as
 * `HistoricalTickService.upsertTicks()` rather than maintaining a second,
 * driftable copy of it.
 *
 * The dedup KEY here must stay byte-for-byte identical to
 * `HistoricalTickService.upsertTicks()`'s own key, and the INSERT's
 * ON CONFLICT target must stay identical to the expression unique index
 * created in `historical_ticks`' own migration
 * (`historical_ticks_identity_key`) -- both are asserted by
 * `test/market-data/historical-tick-dedup.spec.ts`.
 */

export interface IncomingTickLike {
  readonly timestamp: string;
  readonly bid: number;
  readonly ask: number;
  readonly last?: number | null;
  readonly volume?: number | null;
  readonly volumeReal?: number | null;
  readonly flags: number;
  readonly batchSeq: number;
}

/** Last-occurrence-wins dedup, keyed on every field that participates in the real identity (excludes batchSeq -- see the table's own schema comment on why). */
export function dedupeTicks<T extends IncomingTickLike>(ticks: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const tick of ticks) {
    const key = JSON.stringify([tick.timestamp, tick.bid, tick.ask, tick.last ?? null, tick.volume ?? null, tick.volumeReal ?? null, tick.flags]);
    byKey.set(key, tick);
  }
  return [...byKey.values()];
}

export interface ParameterizedInsert {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * Builds a plain, `pg`-compatible parameterized multi-row INSERT (no
 * Prisma.sql template tag -- that's Prisma-specific and unavailable to a
 * plain `pg.Pool`). Every row gets its own `$1, $2, ...` block; `values` is
 * the flat, matching parameter array.
 */
export function buildTickInsert(
  symbol: string,
  brokerSymbol: string | null,
  server: string | null,
  feedId: string | null,
  ticks: readonly IncomingTickLike[],
): ParameterizedInsert {
  const values: unknown[] = [];
  const rowPlaceholders: string[] = [];
  let i = 1;
  for (const t of ticks) {
    rowPlaceholders.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, 'MT5')`,
    );
    values.push(
      symbol,
      brokerSymbol,
      server,
      feedId,
      new Date(t.timestamp),
      t.bid,
      t.ask,
      t.last ?? null,
      t.volume ?? null,
      t.volumeReal ?? null,
      t.flags,
      t.batchSeq,
    );
  }

  const text = `
    INSERT INTO historical_ticks (symbol, broker_symbol, server, feed_id, "timestamp", bid, ask, last, volume, volume_real, flags, batch_seq, source)
    VALUES ${rowPlaceholders.join(', ')}
    ON CONFLICT (symbol, COALESCE(broker_symbol,''), "timestamp", bid, ask, COALESCE(last,-1), COALESCE(volume,-1), COALESCE(volume_real,-1), flags)
    DO NOTHING
  `;
  return { text, values };
}
