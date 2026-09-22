/**
 * The collector-facing contract for Engine B.
 *
 * Its OWN route prefix, `collector/:accountId/telegram-engine/...`,
 * deliberately not a parameter on Engine A's. Two engines place orders on the
 * same broker account from the same collector process; a wire contract that
 * could be confused at the HTTP layer is one that eventually will be, and the
 * confusion would put a Telegram leg's levels onto an RSI order or vice
 * versa. Separate paths make that unreachable rather than unlikely.
 *
 *   GET  pending-leg                  claim the next 0.01 leg to place
 *   POST pending-leg/:legId/result    what the broker actually did
 *   POST reconcile                    broker truth in, recovery state out
 *
 * ## Nothing here approves a trade
 *
 * The engine decided before the leg row was written. These endpoints move an
 * already-decided leg to the terminal and bring the answer back. There is no
 * approval path and no hook for one.
 */
import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsISO8601, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { TelegramLegQueueService } from './leg-queue.service';
import { TelegramReconciliationService } from './reconciliation.service';

export class TelegramLegResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() ticket?: number;
  @IsOptional() @IsNumber() filledPrice?: number;
  @IsOptional() @IsNumber() brokerStopLoss?: number;
  @IsOptional() @IsNumber() brokerTakeProfit?: number;
  @IsOptional() @IsString() errorMessage?: string;
  /**
   * True when the broker's response was lost or ambiguous. Sent separately
   * from `ok` on purpose: "we do not know" is a real outcome, and collapsing
   * it into `ok: false` would release a signal group that may hold a live
   * position.
   */
  @IsOptional() @IsBoolean() uncertain?: boolean;
  /**
   * True when the COLLECTOR refused at its final check and never called the
   * broker. Provably opened nothing, which is why it is distinct from a
   * broker refusal.
   */
  @IsOptional() @IsBoolean() notSent?: boolean;
  @IsOptional() @IsISO8601() submittedAt?: string;
  @IsOptional() @IsISO8601() acknowledgedAt?: string;
}

export class TelegramBrokerPositionDto {
  @IsString() ticket!: string;
  @IsOptional() @IsInt() magic?: number | null;
  @IsString() symbol!: string;
  @IsOptional() @IsString() comment?: string | null;
  @IsNumber() volume!: number;
  @IsOptional() @IsNumber() openPrice?: number | null;
  @IsOptional() @IsNumber() stopLoss?: number | null;
  @IsOptional() @IsNumber() takeProfit?: number | null;
  @IsOptional() @IsNumber() profit?: number | null;
}

export class TelegramBrokerDealDto {
  @IsString() ticket!: string;
  @IsOptional() @IsString() positionId?: string | null;
  @IsOptional() @IsInt() magic?: number | null;
  @IsOptional() @IsString() comment?: string | null;
  @IsNumber() profit!: number;
  @IsOptional() @IsISO8601() closedAt?: string | null;
}

export class TelegramReconcileDto {
  /**
   * Whether the collector could enumerate the account COMPLETELY.
   *
   * This is the single most consequential field on the wire. False means no
   * closure may be concluded from this payload, however empty it looks: an
   * incomplete snapshot and an account with no positions are indistinguishable
   * otherwise, and treating one as the other closes live positions on paper
   * and frees a group that should stay held.
   */
  @IsBoolean() snapshotComplete!: boolean;
  @IsISO8601() snapshotAt!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => TelegramBrokerPositionDto)
  positions!: TelegramBrokerPositionDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => TelegramBrokerDealDto)
  deals!: TelegramBrokerDealDto[];
}

@Controller('collector/:accountId/telegram-engine')
@UseGuards(CollectorTokenGuard)
export class TelegramExecutionController {
  private readonly logger = new Logger(TelegramExecutionController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly legs: TelegramLegQueueService,
    private readonly reconciliation: TelegramReconciliationService,
  ) {}

  /**
   * Claims the next leg to place.
   *
   * The response carries the SOURCE levels as absolute prices, plus the
   * publication timestamp and the first target, so the collector can run its
   * own final check against the terminal's own tick rather than trusting
   * checks made a network round trip ago.
   */
  @Get('pending-leg')
  async getPendingLeg(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const leg = await this.legs.claimNext(accountId, Date.now());
    return { leg: leg ?? null };
  }

  @Post('pending-leg/:legId/result')
  async postLegResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: TelegramLegResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    const status = await this.legs.recordResult(legId, {
      ok: dto.ok,
      ticket: dto.ticket === undefined ? null : String(dto.ticket),
      filledPrice: dto.filledPrice ?? null,
      brokerStopLoss: dto.brokerStopLoss ?? null,
      brokerTakeProfit: dto.brokerTakeProfit ?? null,
      errorMessage: dto.errorMessage ?? null,
      uncertain: dto.uncertain === true,
      notSent: dto.notSent === true,
      submittedAt: dto.submittedAt ? new Date(dto.submittedAt) : null,
      acknowledgedAt: dto.acknowledgedAt ? new Date(dto.acknowledgedAt) : null,
    });
    return { ok: true, status };
  }

  /**
   * Broker truth in, recovery state out.
   *
   * The collector posts what the account actually holds; the engine decides
   * what that means and whether it is now safe to trade. The decision lives
   * here rather than in the collector because it is a rule, not a reading.
   */
  @Post('reconcile')
  async reconcile(@Param('accountId', ParseUUIDPipe) accountId: string, @Body() dto: TelegramReconcileDto) {
    await this.accounts.getOrThrow(accountId);
    const outcome = await this.reconciliation.reconcile({
      accountId,
      nowMs: Date.now(),
      snapshotComplete: dto.snapshotComplete,
      snapshotAtMs: Date.parse(dto.snapshotAt),
      positions: dto.positions.map((p) => ({
        ticket: p.ticket,
        magic: p.magic ?? null,
        symbol: p.symbol,
        comment: p.comment ?? null,
        volume: p.volume,
        openPrice: p.openPrice ?? null,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
        profit: p.profit ?? null,
      })),
      deals: dto.deals.map((d) => ({
        ticket: d.ticket,
        positionId: d.positionId ?? null,
        magic: d.magic ?? null,
        comment: d.comment ?? null,
        profit: d.profit,
        closedAtMs: d.closedAt ? Date.parse(d.closedAt) : null,
      })),
    });
    return outcome;
  }
}
