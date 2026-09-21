import { IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

/** What the collector reports back after attempting a claimed pending order (executor.py's OrderResult, over the wire). */
export class ExecutionResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() ticket?: number;
  @IsOptional() @IsNumber() filledPrice?: number;
  @IsOptional() @IsString() errorMessage?: string;
}
