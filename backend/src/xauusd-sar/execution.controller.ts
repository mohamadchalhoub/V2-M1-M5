/**
 * The collector-facing contract for `xauusd-sar-v1`.
 *
 * Its OWN route prefix, deliberately not a parameter on the frozen RSI
 * strategy's — the same reasoning `xauusd-m1m5/execution.controller.ts`
 * gives for itself.
 *
 *   GET  pending-order              claim the next order to place
 *   POST pending-order/:tag/result  what the broker actually did
 *
 * Nothing here approves a trade. The strategy decided before the row was
 * queued; these endpoints move an already-decided order to the terminal and
 * bring the answer back.
 */
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsISO8601, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { AccountsService } from '../accounts/accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { SarExecutionService } from './execution.service';
import { SarReconciliationService } from './reconciliation.service';
import { SAR_CATASTROPHIC_STOP_USD, SAR_EXPECTED_GOLD_POINT_SIZE, SAR_MAGIC, SAR_SYMBOL } from './safety-constants';

export class SarExecutionResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() ticket?: number;
  @IsOptional() @IsNumber() filledPrice?: number;
  @IsOptional() @IsString() errorMessage?: string;
  /** "We do not know" is a real outcome — see xauusd-m1m5's identical DTO field for why it is never folded into `ok: false`. */
  @IsOptional() @IsBoolean() uncertain?: boolean;
}

export class SarBrokerPositionDto {
  @IsString() ticket!: string;
  @IsOptional() @IsInt() magic?: number | null;
  @IsOptional() @IsString() comment?: string | null;
}

export class SarBrokerDealDto {
  @IsString() ticket!: string;
  @IsOptional() @IsInt() magic?: number | null;
  @IsOptional() @IsString() comment?: string | null;
  @IsString() entry!: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY';
  @IsNumber() price!: number;
}

export class SarReconcileDto {
  /** False means no closure/resolution may be concluded — see the identical field on Engine B's DTO for why. */
  @IsBoolean() snapshotComplete!: boolean;
  @IsISO8601() snapshotAt!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SarBrokerPositionDto)
  positions!: SarBrokerPositionDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => SarBrokerDealDto)
  deals!: SarBrokerDealDto[];
}

@Controller('collector/:accountId/xauusd-sar')
@UseGuards(CollectorTokenGuard)
export class SarExecutionController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly execution: SarExecutionService,
    private readonly reconciliation: SarReconciliationService,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
  ) {}

  @Get('pending-order')
  async getPendingOrder(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const attempt = await this.execution.claimNextOrderAttempt(accountId, Date.now());
    if (!attempt) return { order: null };

    // The ticket being closed, for a REVERSAL, is whatever the session row
    // still shows at claim time — the position this attempt is reversing.
    const session = attempt.kind === 'REVERSAL' ? await this.prisma.xauusdSarSession.findUnique({ where: { accountId } }) : null;

    return {
      order: {
        idempotencyTag: attempt.idempotencyTag,
        kind: attempt.kind,
        side: attempt.direction,
        volume: Number(attempt.volume),
        magic: SAR_MAGIC,
        symbol: SAR_SYMBOL,
        pointSize: SAR_EXPECTED_GOLD_POINT_SIZE,
        catastrophicStopPoints: Math.round(SAR_CATASTROPHIC_STOP_USD / SAR_EXPECTED_GOLD_POINT_SIZE),
        closingTicket: session?.brokerTicket ?? null,
        comment: `sar-${attempt.idempotencyTag}`.slice(0, 26),
      },
    };
  }

  @Post('pending-order/:idempotencyTag/result')
  async postResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('idempotencyTag') idempotencyTag: string,
    @Body() dto: SarExecutionResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    const response = dto.uncertain
      ? { status: 'UNKNOWN' as const, error: dto.errorMessage }
      : dto.ok && dto.ticket !== undefined && dto.filledPrice !== undefined
        ? { status: 'FILLED' as const, ticket: String(dto.ticket), fillPrice: dto.filledPrice }
        : { status: 'FAILED' as const, error: dto.errorMessage };

    const result = await this.execution.resolveOrderAttempt(idempotencyTag, response, Date.now());
    return { ok: true, outcome: result?.action ?? 'ALREADY_RESOLVED' };
  }

  /** Broker truth in, recovery/UNKNOWN-resolution out — see reconciliation.service.ts. */
  @Post('reconcile')
  async reconcile(@Param('accountId', ParseUUIDPipe) accountId: string, @Body() dto: SarReconcileDto) {
    await this.accounts.getOrThrow(accountId);
    const outcome = await this.reconciliation.reconcile({
      accountId,
      nowMs: Date.now(),
      snapshotComplete: dto.snapshotComplete,
      positions: dto.positions.map((p) => ({ ticket: p.ticket, magicNumber: p.magic ?? null, comment: p.comment ?? null })),
      deals: dto.deals.map((d) => ({ ticket: d.ticket, magicNumber: d.magic ?? null, comment: d.comment ?? null, entry: d.entry, price: d.price })),
    });
    return { ok: true, ...outcome };
  }
}
