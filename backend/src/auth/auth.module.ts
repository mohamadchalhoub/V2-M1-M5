import { Module } from '@nestjs/common';
import { CollectorTokenGuard } from './collector-token.guard';
import { DashboardTokenGuard } from './dashboard-token.guard';

@Module({
  providers: [CollectorTokenGuard, DashboardTokenGuard],
  exports: [CollectorTokenGuard, DashboardTokenGuard],
})
export class AuthModule {}
