import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { XtbImportController } from './xtb-import.controller';
import { XtbImportService } from './xtb-import.service';

// Phase 0 §15: xtb-import depends on trading-data — here, "depends on"
// means writes directly to the same `trades` table via Prisma (reusing its
// unique constraint for dedup), not importing TradingDataModule's services,
// which are shaped around the collector's snapshot/heartbeat flow that
// doesn't apply to a batch file import.
@Module({
  imports: [AccountsModule, AuthModule],
  controllers: [XtbImportController],
  providers: [XtbImportService],
  exports: [XtbImportService],
})
export class XtbImportModule {}
