import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { TechnicalAnalysisReportService } from './technical-analysis-report.service';

/**
 * Read-only, for the dashboard — same posture as RulesController/
 * HistoricalChartsController (no POST/PATCH; technical-analysis is
 * computed on demand, never edited). EURUSD only, same explicit scope as
 * historical-charts.controller.ts. Dashboard-authenticated and
 * account-bound for URL-convention consistency with the rest of this API,
 * even though the underlying data itself isn't account-specific (there is
 * only one EURUSD market) — the account param exists so this route needs
 * no separate auth model, not because the report varies by account.
 */
@Controller('accounts/:accountId/technical-analysis')
@UseGuards(DashboardTokenGuard)
export class TechnicalAnalysisController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly technicalAnalysis: TechnicalAnalysisReportService,
  ) {}

  @Get()
  async getReport(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    return this.technicalAnalysis.getFullReport(new Date());
  }
}
