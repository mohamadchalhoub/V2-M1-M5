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
import { SAR_CATASTROPHIC_STOP_USD, SAR_EXPECTED_GOLD_POINT_SIZE, SAR_MAGIC, SAR_SYMBOL, sarOrderComment } from './safety-constants';
import { readQuoteCandidates } from '../xauusd-m1m5/quote-sources';
import { resolveQuote } from '../xauusd-m1m5/quote';

export class SarExecutionResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() ticket?: number;
  @IsOptional() @IsNumber() filledPrice?: number;
  /** For a REVERSAL: the actual price the closed position filled at, as reported by the broker's close deal -- distinct from the new position's `filledPrice`. */
  @IsOptional() @IsNumber() closeFillPrice?: number;
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
  /** The deal's own ticket -- NOT the position it belongs to. Never used to identify a position; see `positionId`. */
  @IsString() ticket!: string;
  /**
   * The POSITION this deal belongs to. For an entry (IN) deal this becomes
   * the new position's ticket; for an exit (OUT) deal this is how the
   * closed position is matched back to the ticket reconciliation is
   * watching. MT5 carries this on every deal distinctly from the deal's own
   * ticket, and conflating the two was a latent bug here (the deal ticket
   * was previously read as if it were the position ticket, never exercised
   * before this was actually wired to a live feed).
   */
  @IsOptional() @IsString() positionId?: string | null;
  @IsOptional() @IsInt() magic?: number | null;
  @IsOptional() @IsString() comment?: string | null;
  @IsString() entry!: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY';
  @IsNumber() price!: number;
}

export class SarReconcileDto {
  /** False means no closure/resolution may be concluded — see the identical field on Engine B's DTO for why. */
  @IsBoolean() snapshotComplete!: boolean;
  /** Whether the collector's own MT5 terminal was connected when this snapshot was taken. False blocks every resolution, same as an incomplete snapshot -- an snapshot pulled from a disconnected terminal is not authoritative. */
  @IsBoolean() mt5Connected!: boolean;
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
        comment: sarOrderComment(attempt.idempotencyTag),
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
        ? { status: 'FILLED' as const, ticket: String(dto.ticket), fillPrice: dto.filledPrice, closeFillPrice: dto.closeFillPrice }
        : { status: 'FAILED' as const, error: dto.errorMessage };

    const result = await this.execution.resolveOrderAttempt(idempotencyTag, response, Date.now());
    return { ok: true, outcome: result?.action ?? 'ALREADY_RESOLVED' };
  }

  /**
   * Defense-in-depth against the normal scheduler process itself stalling
   * or crashing -- a genuinely SEPARATE process/container from this API,
   * per docker-compose. The collector polls this every second from its own
   * independent fast pass, so this stays reachable even if the scheduler
   * container's own event loop hangs. See SarExecutionService.watchdogCheck
   * for why this can never produce a second broker attempt alongside the
   * normal path.
   *
   * Resolves its own fresh quote from the same source
   * (readQuoteCandidates/resolveQuote) the normal scheduler uses, rather
   * than trusting a bid/ask the collector would otherwise have to carry --
   * one quote-freshness definition, not two that could quietly disagree.
   */
  @Get('watchdog-check')
  async watchdogCheck(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const nowMs = Date.now();
    const candidates = await readQuoteCandidates(this.prisma);
    const resolved = resolveQuote(candidates, nowMs);
    const quote = resolved.quote
      ? { bid: resolved.quote.bid, ask: resolved.quote.ask, ageSeconds: resolved.quote.ageSeconds, fresh: resolved.quote.fresh }
      : { bid: 0, ask: 0, ageSeconds: Infinity, fresh: false };
    const result = await this.execution.watchdogCheck(accountId, quote, nowMs);
    return { ok: true, action: result.action, detail: result.detail, watchdogActed: result.watchdogActed };
  }

  /** Broker truth in, recovery/UNKNOWN-resolution out — see reconciliation.service.ts. */
  @Post('reconcile')
  async reconcile(@Param('accountId', ParseUUIDPipe) accountId: string, @Body() dto: SarReconcileDto) {
    await this.accounts.getOrThrow(accountId);
    const outcome = await this.reconciliation.reconcile({
      accountId,
      nowMs: Date.now(),
      snapshotAtMs: Date.parse(dto.snapshotAt),
      snapshotComplete: dto.snapshotComplete,
      mt5Connected: dto.mt5Connected,
      positions: dto.positions.map((p) => ({ ticket: p.ticket, magicNumber: p.magic ?? null, comment: p.comment ?? null })),
      deals: dto.deals.map((d) => ({
        ticket: d.ticket,
        positionId: d.positionId ?? null,
        magicNumber: d.magic ?? null,
        comment: d.comment ?? null,
        entry: d.entry,
        price: d.price,
      })),
    });
    return { ok: true, ...outcome };
  }
}
