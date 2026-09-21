import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class IncomingTickDto {
  @IsISO8601() timestamp!: string;
  @IsNumber() bid!: number;
  @IsNumber() ask!: number;
  @IsOptional() @IsNumber() last?: number;
  @IsOptional() @IsNumber() volume?: number;
  @IsOptional() @IsNumber() volumeReal?: number;
  @IsInt() flags!: number;
  // 0-based position within the single copy_ticks_range() call that
  // returned this tick — a same-batch ordering diagnostic only, NOT part
  // of this row's identity (see HistoricalTick's own schema comment).
  @IsInt() @Min(0) batchSeq!: number;
}

// No accountId — same "market data, not account data" posture as
// CandlesPushDto/SymbolMetadataPushDto: ticks are symbol-level market data,
// shared across every account. Any valid, unrevoked collector-scope token
// may push here (CollectorTokenGuard's own contract).
export class TicksPushDto {
  @IsString() symbol!: string;
  @IsOptional() @IsString() brokerSymbol?: string;
  @IsOptional() @IsString() server?: string;
  @IsOptional() @IsString() feedId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => IncomingTickDto)
  ticks!: IncomingTickDto[];
}
