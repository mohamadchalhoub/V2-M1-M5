import { BadRequestException, Injectable } from '@nestjs/common';
import { ImportBatch, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AccountsService } from '../accounts/accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseXtbClosedPositionsCsv, parseXtbClosedPositionsXlsx, XtbParseResult } from './xtb-csv-parser';

/**
 * Owns upload + parsing + writing to the normalized store (Phase 0 §15).
 * Depends only on `trading-data`'s tables directly (via Prisma) — reuses
 * `Trade`'s own (account_id, platform, external_trade_id) unique constraint
 * for row-level dedup rather than building a second mechanism (Phase 0 §06:
 * "no ingestion path in this system is allowed to use a bare INSERT against
 * a table that has an external counterpart").
 *
 * One XTB "closed position" row becomes TWO Trade rows — a synthetic IN
 * (open leg) and OUT (close leg, carrying the realized P/L) — because the
 * schema's deal-level model (ANALYTICS_SPEC.md §0: "closing deals carry the
 * realized P/L") already expects that shape for MT5, and analytics
 * (averageHistoricalPositionVolume, etc.) reads opening size specifically
 * from IN deals. External trade ids are `${orderId}-IN`/`${orderId}-OUT`.
 */
@Injectable()
export class XtbImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async importCsv(accountId: string, fileName: string | null, csvContent: string): Promise<ImportBatch> {
    if (!csvContent || csvContent.trim() === '') {
      throw new BadRequestException('csvContent must not be empty');
    }
    const batch = await this.startBatch(accountId, fileName, Buffer.from(csvContent, 'utf8'));
    if (batch.status === 'COMPLETED') return batch; // whole-file dedup — never re-parse an already-completed batch
    return this.processResult(batch, parseXtbClosedPositionsCsv(csvContent));
  }

  /**
   * Historical chart reconstruction phase — XTB/xStation5's real export is
   * an .xlsx workbook (verified against a real file); `xlsxContentBase64`
   * is the same JSON-string-field content this endpoint already used for
   * CSV, just base64-encoded since it's binary. Shares every other step
   * (whole-file dedup, batch bookkeeping, row-level dedup, the two-Trade-
   * rows-per-position write) with `importCsv` via `startBatch`/`processResult`
   * — only the parser differs.
   */
  async importXlsx(accountId: string, fileName: string | null, xlsxContentBase64: string): Promise<ImportBatch> {
    if (!xlsxContentBase64 || xlsxContentBase64.trim() === '') {
      throw new BadRequestException('xlsxContentBase64 must not be empty');
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(xlsxContentBase64, 'base64');
      if (buffer.length === 0) throw new Error('decoded to zero bytes');
    } catch {
      throw new BadRequestException('xlsxContentBase64 is not valid base64');
    }
    const batch = await this.startBatch(accountId, fileName, buffer);
    if (batch.status === 'COMPLETED') return batch; // whole-file dedup — never re-parse an already-completed batch
    return this.processResult(batch, await parseXtbClosedPositionsXlsx(buffer));
  }

  private async startBatch(accountId: string, fileName: string | null, fileBytes: Buffer): Promise<ImportBatch> {
    const account = await this.accounts.getOrThrow(accountId);
    if (account.platform !== 'XTB') {
      throw new BadRequestException(
        `Account ${accountId} is platform=${account.platform}, not XTB — XTB import only writes to XTB accounts`,
      );
    }

    const fileSha256 = createHash('sha256').update(fileBytes).digest('hex');

    const existing = await this.prisma.importBatch.findUnique({
      where: { accountId_fileSha256: { accountId, fileSha256 } },
    });
    if (existing?.status === 'COMPLETED') {
      // Whole-file dedup (Phase 0 §06) — re-uploading the same export is a
      // no-op batch, not a re-processing of every row. Both callers
      // (importCsv/importXlsx) check `.status === 'COMPLETED'` on the
      // returned batch and skip parsing entirely in that case.
      return existing;
    }
    // A PENDING batch here means a previous attempt was interrupted before
    // finishing (e.g. a crash mid-import); FAILED means a previous attempt
    // errored. Either way, re-process — row-level dedup (below) means any
    // rows a partial prior attempt already committed are correctly skipped,
    // not double-imported. This makes re-uploading the identical file after
    // a crash the natural "resume" action, with no separate resume flow.
    return existing ?? this.prisma.importBatch.create({ data: { accountId, fileSha256, fileName, status: 'PENDING' } });
  }

  private async processResult(batch: ImportBatch, parseResult: XtbParseResult): Promise<ImportBatch> {
    if (batch.status === 'COMPLETED') return batch;
    const accountId = batch.accountId;
    const { rows, errors } = parseResult;

    if (rows.length === 0 && errors.length > 0) {
      return this.prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          status: 'FAILED',
          rowsTotal: 0,
          error: errors[0].message.slice(0, 500),
          completedAt: new Date(),
        },
      });
    }

    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      const inTicket = `${row.orderId}-IN`;
      const outTicket = `${row.orderId}-OUT`;

      const alreadyImported = await this.prisma.trade.findUnique({
        where: { accountId_platform_externalTradeId: { accountId, platform: 'XTB', externalTradeId: outTicket } },
        select: { id: true },
      });
      if (alreadyImported) {
        skipped += 1;
        continue;
      }

      await this.prisma.$transaction([
        this.prisma.trade.upsert({
          where: { accountId_platform_externalTradeId: { accountId, platform: 'XTB', externalTradeId: inTicket } },
          create: {
            accountId,
            platform: 'XTB',
            externalTradeId: inTicket,
            positionId: row.orderId,
            symbol: row.symbol,
            side: row.side,
            dealEntry: 'IN',
            volume: row.volume,
            price: row.openPrice,
            commission: 0,
            swap: 0,
            profit: 0,
            executedAt: row.openTime,
            comment: row.comment,
            stopLoss: row.stopLoss,
            takeProfit: row.takeProfit,
            rawPayload: row.raw as Prisma.InputJsonValue,
          },
          update: {},
        }),
        this.prisma.trade.upsert({
          where: { accountId_platform_externalTradeId: { accountId, platform: 'XTB', externalTradeId: outTicket } },
          create: {
            accountId,
            platform: 'XTB',
            externalTradeId: outTicket,
            positionId: row.orderId,
            symbol: row.symbol,
            side: row.side,
            dealEntry: 'OUT',
            volume: row.volume,
            price: row.closePrice,
            commission: row.commission,
            swap: row.swap,
            profit: row.profit,
            executedAt: row.closeTime,
            comment: row.comment,
            stopLoss: row.stopLoss,
            takeProfit: row.takeProfit,
            rawPayload: row.raw as Prisma.InputJsonValue,
          },
          update: {},
        }),
      ]);
      imported += 1;
    }

    const status = imported === 0 && errors.length > 0 ? 'FAILED' : 'COMPLETED';
    return this.prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status,
        rowsTotal: rows.length + errors.length,
        rowsImported: imported,
        rowsSkipped: skipped + errors.length,
        error:
          errors.length > 0
            ? `${errors.length} row(s) could not be parsed; first: ${errors[0].message}`.slice(0, 500)
            : null,
        completedAt: new Date(),
      },
    });
  }

  async listBatches(accountId: string) {
    await this.accounts.getOrThrow(accountId);
    return this.prisma.importBatch.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' } });
  }
}
