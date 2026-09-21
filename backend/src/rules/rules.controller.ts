import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { RuleDefinitionsService } from './rule-definitions.service';
import { RuleStateService } from './rule-state.service';

// Read-only, for the dashboard (Phase 9 §17: "read-only views first,
// rule-editing UI last"). Creating/updating/enabling rules stays
// script-only (scripts/manage-rules.ts) — this endpoint intentionally has
// no POST/PATCH counterpart. Dashboard-authenticated and account-bound
// (production-readiness review — Option B).
@Controller('accounts/:accountId/rules')
@UseGuards(DashboardTokenGuard)
export class RulesController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly ruleDefinitions: RuleDefinitionsService,
    private readonly ruleStates: RuleStateService,
  ) {}

  @Get()
  async list(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const rules = await this.ruleDefinitions.findAllForAccount(accountId);
    const states = await this.ruleStates.getManyByIds(rules.map((r) => r.id));
    return rules.map((rule) => ({ ...rule, state: states.get(rule.id) ?? null }));
  }
}
