import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class IncomingPositionDto {
  @IsString() externalPositionId!: string;
  @IsString() symbol!: string;
  @IsIn(['BUY', 'SELL']) side!: 'BUY' | 'SELL';
  @IsNumber() volume!: number;
  @IsNumber() openPrice!: number;
  @IsOptional() @IsNumber() currentPrice?: number;
  @IsOptional() @IsNumber() stopLoss?: number;
  @IsOptional() @IsNumber() takeProfit?: number;
  @IsNumber() profit!: number;
  @IsNumber() swap!: number;
  @IsISO8601() openedAt!: string;
  @IsOptional() raw?: Record<string, unknown>;
}

export class TerminalStatusDto {
  @IsBoolean() connected!: boolean;
  @IsOptional() @IsString() lastError?: string;
}

/** Global market data, not account-scoped — piggybacked onto the same 10s
 * snapshot push rather than a new endpoint. See LiveTick's own schema comment. */
export class LiveTickDto {
  @IsString() symbol!: string;
  @IsNumber() bid!: number;
  @IsNumber() ask!: number;
  @IsISO8601() tickAt!: string;
}

export class SnapshotDto {
  @IsUUID() accountId!: string;
  @IsISO8601() capturedAt!: string;

  @IsNumber() balance!: number;
  @IsNumber() equity!: number;
  @IsNumber() margin!: number;
  @IsNumber() freeMargin!: number;
  @IsOptional() @IsNumber() marginLevel?: number;
  @IsNumber() profit!: number;

  /** Autonomous demo trading (v2) — from MT5's own account_info().trade_mode. Optional: an older collector, or one not yet updated to read it, simply omits this rather than guessing. */
  @IsOptional() @IsIn(['REAL', 'DEMO', 'CONTEST']) tradeMode?: 'REAL' | 'DEMO' | 'CONTEST';

  /**
   * From MT5's own account_info().margin_mode. Optional for the same reason
   * as tradeMode: an older collector omits it, and omitted must stay
   * distinguishable from an asserted RETAIL_NETTING.
   */
  @IsOptional() @IsIn(['RETAIL_NETTING', 'EXCHANGE', 'RETAIL_HEDGING'])
  marginMode?: 'RETAIL_NETTING' | 'EXCHANGE' | 'RETAIL_HEDGING';

  // @IsDefined() is required alongside @ValidateNested() here — class-validator
  // skips nested validation entirely when the property itself is `undefined`
  // (a request body that omits `terminal` altogether), which previously let a
  // malformed push reach the controller and crash with an unhandled 500 on
  // `dto.terminal.connected` instead of a clean 400 (found during production
  // readiness review's live end-to-end test).
  @IsDefined() @ValidateNested() @Type(() => TerminalStatusDto)
  terminal!: TerminalStatusDto;

  @IsOptional() @IsString() collectorVersion?: string;

  @IsOptional() @ValidateNested() @Type(() => LiveTickDto)
  liveTick?: LiveTickDto;

  /** One quote per collected symbol (e.g. EURUSD and XAUUSD). `liveTick` above is kept unchanged for existing consumers. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => LiveTickDto)
  liveTicks?: LiveTickDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IncomingPositionDto)
  positions!: IncomingPositionDto[];
}
