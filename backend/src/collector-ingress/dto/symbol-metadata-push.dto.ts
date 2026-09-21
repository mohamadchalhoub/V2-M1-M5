import { IsInt, IsISO8601, IsNumber, IsOptional, IsPositive, IsString, Matches, Min } from 'class-validator';

// No accountId — same "market data, not account data" posture as
// CandlesPushDto: symbol metadata is shared across every account/collector
// that trades the same broker symbol. Any valid, unrevoked collector-scope
// token may push here (CollectorTokenGuard's own contract).
export class SymbolMetadataPushDto {
  @IsString() symbol!: string;
  @IsNumber() @Min(0) volumeMin!: number;
  @IsNumber() @IsPositive() volumeMax!: number;
  @IsNumber() @IsPositive() volumeStep!: number;
  @IsInt() @Min(0) digits!: number;
  @IsNumber() @IsPositive() point!: number;
  @IsNumber() @IsPositive() contractSize!: number;
  // Not restricted to a fixed list — currency-conversion.ts's own
  // `resolveConversionRate` is what actually fails closed on an
  // unsupported currency combination; this DTO only checks the SHAPE
  // (a plausible ISO-4217-looking code), not which currencies this
  // system currently knows how to convert.
  @IsString() @Matches(/^[A-Z]{3}$/) profitCurrency!: string;

  // Gold historical-collection phase — instrument-verification fields
  // (§A1/A2 of the collection plan). All additive/optional, fully backward
  // compatible with every existing collector push that doesn't send them.
  @IsOptional() @IsString() brokerSymbol?: string;
  @IsOptional() @IsString() server?: string;
  @IsOptional() @IsString() path?: string;
  @IsOptional() @IsString() currencyBase?: string;
  @IsOptional() @IsString() currencyProfit?: string;
  @IsOptional() @IsString() currencyMargin?: string;
  @IsOptional() @IsNumber() tradeTickSize?: number;
  @IsOptional() @IsNumber() tradeTickValue?: number;
  @IsOptional() @IsInt() tradeStopsLevel?: number;
  @IsOptional() @IsInt() tradeFreezeLevel?: number;
  @IsOptional() @IsInt() tradeMode?: number;
  @IsOptional() @IsInt() swapMode?: number;
  @IsOptional() @IsNumber() swapLong?: number;
  @IsOptional() @IsNumber() swapShort?: number;
  @IsOptional() @IsInt() swapRollover3Days?: number;
  @IsOptional() @IsInt() expirationMode?: number;
  @IsOptional() @IsISO8601() expirationTime?: string;
}
