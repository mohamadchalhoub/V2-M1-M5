import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { AlertLifecycleService } from '../../src/alerts/alert-lifecycle.service';
import { RuleEngineService } from '../../src/alerts/rule-engine.service';
import { RuleDefinitionsService } from '../../src/rules/rule-definitions.service';
import { RuleStateService } from '../../src/rules/rule-state.service';

/**
 * Builds the real DI graph (same AppModule the HTTP app uses — see
 * test/helpers/app.ts) without starting an HTTP listener, so DB-backed rule
 * engine tests get real ConfigService/PrismaService wiring without needing a
 * Fastify adapter.
 */
export async function buildRuleEngineContext() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const context: INestApplicationContext = await moduleRef.init();

  return {
    context,
    ruleDefinitions: context.get(RuleDefinitionsService),
    ruleStates: context.get(RuleStateService),
    alertLifecycle: context.get(AlertLifecycleService),
    ruleEngine: context.get(RuleEngineService),
  };
}
