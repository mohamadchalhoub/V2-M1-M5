import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { ImportXtbCsvDto } from './dto/import-xtb-csv.dto';
import { XtbImportService } from './xtb-import.service';

// Dashboard-authenticated and account-bound (production-readiness review —
// Option B): this endpoint writes trading data for an EXISTING account only
// (never creates one) — DashboardTokenGuard reads dto.accountId from the
// JSON body for POST (there's no :accountId in this route's own URL) and
// rejects a token bound to a different account before the handler runs, so
// a token for account A can never import data into account B.
@Controller('xtb-import')
@UseGuards(DashboardTokenGuard)
export class XtbImportController {
  constructor(private readonly xtbImport: XtbImportService) {}

  @Post()
  async import(@Body() dto: ImportXtbCsvDto) {
    if (dto.csvContent && dto.xlsxContentBase64) {
      throw new BadRequestException('Provide exactly one of csvContent or xlsxContentBase64, not both');
    }
    if (dto.xlsxContentBase64) {
      return this.xtbImport.importXlsx(dto.accountId, dto.fileName ?? null, dto.xlsxContentBase64);
    }
    if (dto.csvContent) {
      return this.xtbImport.importCsv(dto.accountId, dto.fileName ?? null, dto.csvContent);
    }
    throw new BadRequestException('Provide either csvContent or xlsxContentBase64');
  }

  @Get('batches/:accountId')
  async listBatches(@Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.xtbImport.listBatches(accountId);
  }
}
