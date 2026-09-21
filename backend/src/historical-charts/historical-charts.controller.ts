import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { TradeAlignmentService } from './trade-alignment.service';

// EURUSD only for this pass (RECONSTRUCTION spec's own explicit scope) —
// the service itself is symbol-parameterized, but the route only exposes
// EURUSD until a second symbol is actually asked for, per "keep the
// implementation minimal." Dashboard-authenticated and account-bound, same
// posture as trading-data.controller.ts.
const SYMBOL = 'EURUSD';

@Controller('accounts/:accountId/eurusd-trades')
@UseGuards(DashboardTokenGuard)
export class HistoricalChartsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly tradeAlignment: TradeAlignmentService,
  ) {}

  @Get()
  async listRoundTrips(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    return this.tradeAlignment.getRoundTrips(accountId, SYMBOL);
  }

  @Get(':positionId/chart')
  async getChart(@Param('accountId', ParseUUIDPipe) accountId: string, @Param('positionId') positionId: string) {
    await this.accounts.getOrThrow(accountId);
    return this.tradeAlignment.getTradeChartWindow(accountId, SYMBOL, positionId);
  }
}
