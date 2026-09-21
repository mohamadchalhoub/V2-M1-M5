import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read/write access to `SymbolMetadata` (schema.prisma) — broker-reported
 * volume min/max/step, price increment (point), contract size, and profit
 * currency for one broker symbol. Global, no accountId, same "market data"
 * posture as `LiveTick`/`HistoricalCandle`.
 *
 * Populated by the collector (once `mt5_client.py`'s `get_symbol_info` is
 * wired to push it — see the delivery report's "remaining prerequisites").
 * This sandbox/dev environment has never had a live MT5 terminal connected,
 * so this table is empty here today; every caller of `get()` must treat
 * `null` as "unknown," never assume permissive defaults.
 */
export interface SymbolMetadataRow {
  symbol: string;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  digits: number;
  point: number;
  contractSize: number;
  profitCurrency: string;
  updatedAt: Date;
}

// Gold historical-collection phase — instrument-verification fields
// (§A1/A2 of the collection plan). All optional/nullable: not every
// broker/symbol populates every one of these, and rows written before this
// phase existed simply don't have them.
export interface SymbolMetadataUpsertInput extends Omit<SymbolMetadataRow, 'updatedAt'> {
  brokerSymbol?: string | null;
  server?: string | null;
  path?: string | null;
  currencyBase?: string | null;
  currencyProfit?: string | null;
  currencyMargin?: string | null;
  tradeTickSize?: number | null;
  tradeTickValue?: number | null;
  tradeStopsLevel?: number | null;
  tradeFreezeLevel?: number | null;
  tradeMode?: number | null;
  swapMode?: number | null;
  swapLong?: number | null;
  swapShort?: number | null;
  swapRollover3Days?: number | null;
  expirationMode?: number | null;
  expirationTime?: string | Date | null;
}

@Injectable()
export class SymbolMetadataService {
  constructor(private readonly prisma: PrismaService) {}

  async get(symbol: string): Promise<SymbolMetadataRow | null> {
    const row = await this.prisma.symbolMetadata.findUnique({ where: { symbol } });
    if (!row) return null;
    return {
      symbol: row.symbol,
      volumeMin: row.volumeMin.toNumber(),
      volumeMax: row.volumeMax.toNumber(),
      volumeStep: row.volumeStep.toNumber(),
      digits: row.digits,
      point: row.point.toNumber(),
      contractSize: row.contractSize.toNumber(),
      profitCurrency: row.profitCurrency,
      updatedAt: row.updatedAt,
    };
  }

  /** Upserted by the collector-ingress route (`collector-ingress.controller.ts`) on its normal push cadence — see that file for the `CollectorTokenGuard`-protected endpoint. */
  async upsert(row: SymbolMetadataUpsertInput): Promise<void> {
    const { symbol, expirationTime, ...rest } = row;
    const data = {
      ...rest,
      expirationTime: expirationTime != null ? new Date(expirationTime) : null,
    };
    await this.prisma.symbolMetadata.upsert({
      where: { symbol },
      create: { symbol, ...data, source: 'MT5' },
      update: { ...data },
    });
  }
}
