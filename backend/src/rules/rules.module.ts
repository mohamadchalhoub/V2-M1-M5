import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { RuleDefinitionsService } from './rule-definitions.service';
import { RuleStateService } from './rule-state.service';
import { RulesController } from './rules.controller';

@Module({
  imports: [AccountsModule, AuthModule],
  controllers: [RulesController],
  providers: [RuleDefinitionsService, RuleStateService],
  exports: [RuleDefinitionsService, RuleStateService],
})
export class RulesModule {}
