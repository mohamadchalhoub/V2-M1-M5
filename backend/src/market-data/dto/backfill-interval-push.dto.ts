import { IsIn, IsInt, IsISO8601, IsOptional, IsString } from 'class-validator';

const DATA_TYPES = ['CANDLE', 'TICK'] as const;
// M1 included alongside the existing 8 (technical-analysis.config.ts's own
// separate VALID_TIMEFRAMES/ICHIMOKU_TIMEFRAMES lists are a deliberately
// different, unrelated feature and are not touched here).
const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'M30', 'H4', 'D1', 'W1', 'MN1'] as const;
const STATUSES = [
  'PENDING',
  'COMPLETED',
  'EMPTY_UNCONFIRMED',
  'EMPTY_CONFIRMED',
  'FAILED',
  'INCOMPLETE',
  'SUSPECTED_TRUNCATED',
] as const;

// No accountId — same "market data, not account data" posture as every
// other collector-ingress route in this file: the coverage ledger is
// symbol/timeframe data, shared across every account/collector.
export class BackfillIntervalPushDto {
  @IsOptional() @IsString() source?: string;
  @IsString() symbol!: string;
  @IsOptional() @IsString() brokerSymbol?: string;
  @IsOptional() @IsString() server?: string;
  @IsIn(DATA_TYPES) dataType!: (typeof DATA_TYPES)[number];
  // Only meaningful for dataType=CANDLE; omit for TICK (BackfillIntervalService
  // fills in the NOT NULL `timeframeKey` companion internally either way).
  @IsOptional() @IsIn(TIMEFRAMES) timeframe?: (typeof TIMEFRAMES)[number];
  @IsISO8601() rangeStart!: string;
  @IsISO8601() rangeEnd!: string;
  @IsIn(STATUSES) status!: (typeof STATUSES)[number];
  @IsOptional() @IsInt() recordCount?: number;
  @IsOptional() @IsString() evidence?: string;
}
