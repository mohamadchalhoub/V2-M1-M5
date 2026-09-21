import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class IncomingDealDto {
  @IsString() externalTradeId!: string; // MT5 deal ticket
  @IsOptional() @IsString() positionId?: string;
  @IsOptional() @IsString() orderId?: string;
  @IsString() symbol!: string;
  @IsIn(['BUY', 'SELL']) side!: 'BUY' | 'SELL';
  @IsIn(['IN', 'OUT', 'INOUT', 'OUT_BY']) dealEntry!: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY';
  @IsNumber() volume!: number;
  @IsNumber() price!: number;
  @IsNumber() commission!: number;
  @IsNumber() swap!: number;
  @IsNumber() profit!: number;
  @IsISO8601() executedAt!: string;
  @IsOptional() @IsString() comment?: string;
  @IsOptional() raw?: Record<string, unknown>;
}

export class TradesPushDto {
  @IsUUID() accountId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IncomingDealDto)
  deals!: IncomingDealDto[];
}
