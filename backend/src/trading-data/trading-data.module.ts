import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { TradingDataController } from './trading-data.controller';
import { TradingDataService } from './trading-data.service';

@Module({
  imports: [AccountsModule, AuthModule],
  controllers: [TradingDataController],
  providers: [TradingDataService],
  exports: [TradingDataService],
})
export class TradingDataModule {}
