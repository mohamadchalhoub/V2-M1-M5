import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsISO8601, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

export class IncomingCandleDto {
  @IsISO8601() openTime!: string;
  @IsNumber() open!: number;
  @IsNumber() high!: number;
  @IsNumber() low!: number;
  @IsNumber() close!: number;
  @IsOptional() @IsNumber() volume?: number;
}

// No accountId — candles are symbol/timeframe market data, not scoped to
// any one account (schema.prisma's HistoricalCandle comment). Any valid,
// unrevoked collector-scope token may push here (CollectorTokenGuard's own
// contract: a request that names no target accountId is never rejected for
// account mismatch — see auth/collector-token.guard.ts's `requestedAccountId`).
export class CandlesPushDto {
  @IsString() symbol!: string;
  @IsIn(['M1', 'M5', 'M15', 'H1', 'M30', 'H4', 'D1', 'W1', 'MN1']) timeframe!: 'M1' | 'M5' | 'M15' | 'H1' | 'M30' | 'H4' | 'D1' | 'W1' | 'MN1';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => IncomingCandleDto)
  candles!: IncomingCandleDto[];
}
