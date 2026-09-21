/**
 * Manual trigger for the full autonomous decision pipeline — mechanical
 * rule engine (Phase 2/3), the AI confirmation layer on top of it
 * (Phase 4), and, when AI_ENABLED=true and AUTONOMOUS_TRADING_ACCOUNT_ID
 * is set, the risk manager using REAL account state (Phase 6) — queuing an
 * approved order for the collector to pick up if everything passes.
 * (AUTONOMOUS_DEMO_TRADING_PLAN.md, backend/src/autonomous/AUTONOMOUS_RULE_ENGINE_SPEC.md)
 *
 * Deliberately still the ONLY way any of this runs — there is no scheduler
 * in this repo that calls this pipeline automatically. That is an
 * intentional, separate decision: someone has to run this by hand (or a
 * human-supervised cron, later) until the system has been watched
 * behaving correctly enough times to trust it unsupervised.
 *
 * Deliberately a CLI script, not a new HTTP endpoint — same reasoning as
 * `trigger-daily-analysis.ts`: this app has no admin/operator auth tier
 * separate from per-account dashboard tokens, and this evaluation isn't
 * account-scoped at all (the friend's rule only ever looks at EURUSD market
 * data), so there's no natural route to hang it off anyway.
 *
 * Run: npm run evaluate-autonomous-rule
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { loadAiConfig } from '../src/ai/ai.config';
import { HistoricalPatternSummaryService } from '../src/ai/historical-pattern-summary.service';
import { TradeAlignmentService } from '../src/historical-charts/trade-alignment.service';
import { HistoricalCandleService } from '../src/market-data/historical-candle.service';
import { MarketEventQueryService } from '../src/market-events/market-event-query.service';
import { loadAutonomousRulesConfig } from '../src/autonomous/autonomous-rules.config';
import { AutonomousRuleEngineService } from '../src/autonomous/autonomous-rule-engine.service';
import { AutonomousDecisionLoggerService } from '../src/autonomous/autonomous-decision-logger.service';
import { AutonomousAiDecisionService } from '../src/autonomous/autonomous-ai-decision.service';
import { AutonomousExecutionCoordinatorService } from '../src/autonomous/autonomous-execution-coordinator.service';
import { buildAutonomousAiProvider } from '../src/autonomous/autonomous-ai-provider.factory';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const config = new ConfigService(process.env);

  try {
    const rulesConfig = loadAutonomousRulesConfig(config);
    const candles = new HistoricalCandleService(prisma as any);
    const ruleEngine = new AutonomousRuleEngineService(candles, rulesConfig);
    const logger = new AutonomousDecisionLoggerService(prisma as any);

    const now = new Date();

    const aiConfig = loadAiConfig(config);
    if (!aiConfig.enabled) {
      console.log('AI_ENABLED=false — running the mechanical rule engine only (Phase 2/3 path).');
      // No execution module involved in this path — always 0.
      const result = await ruleEngine.evaluate(now, 0);
      printMechanical(result);
      const logged = await logger.log(result.decision, { now: now.toISOString(), ...result, config: rulesConfig });
      console.log(`Logged as AutonomousDecision ${logged.id} (source=RULES_ONLY)`);
      return;
    }

    const accountId = config.get<string>('AUTONOMOUS_TRADING_ACCOUNT_ID')?.trim();
    const tradeAlignment = new TradeAlignmentService(prisma as any, candles);
    const historicalPattern = new HistoricalPatternSummaryService(tradeAlignment);
    const marketEvents = new MarketEventQueryService(prisma as any);
    const aiProvider = buildAutonomousAiProvider(aiConfig);
    const aiDecisionService = new AutonomousAiDecisionService(ruleEngine, historicalPattern, marketEvents, aiProvider, rulesConfig);

    if (!accountId) {
      console.log(
        `AI_ENABLED=true (provider=${aiConfig.provider}, model=${aiConfig.model}) but AUTONOMOUS_TRADING_ACCOUNT_ID is not set — ` +
          'running the AI-assisted path WITHOUT the risk manager (no order can be queued; nothing to attach one to).',
      );
      const { mechanical, ai } = await aiDecisionService.evaluate(now, 0);
      printMechanical(mechanical);
      printAi(ai);
      const logged = await logger.logAiAssisted(mechanical.decision, ai, null, null, { now: now.toISOString(), mechanical, ai, config: rulesConfig });
      console.log(`Logged as AutonomousDecision ${logged.id} (source=AI_ASSISTED, no risk-manager check)`);
      return;
    }

    console.log(`AI_ENABLED=true (provider=${aiConfig.provider}, model=${aiConfig.model}), account=${accountId} — running the full Phase 6 pipeline.`);
    const coordinator = new AutonomousExecutionCoordinatorService(aiDecisionService, logger, prisma as any, rulesConfig);
    const { mechanical, ai, riskManager, loggedDecisionId } = await coordinator.run(now, accountId);

    printMechanical(mechanical);
    printAi(ai);
    if (riskManager) {
      console.log(`Risk manager: ${riskManager.approved ? 'APPROVED — order queued as PENDING for the collector.' : `REJECTED — ${riskManager.rejectionReason}`}`);
    }
    console.log(`Logged as AutonomousDecision ${loggedDecisionId} (source=AI_ASSISTED)`);
  } finally {
    await prisma.$disconnect();
  }
}

function printMechanical(result: Awaited<ReturnType<AutonomousRuleEngineService['evaluate']>>): void {
  if (result.h4Levels) {
    console.log(
      `Reference week ${result.h4Levels.referenceWeekStart.toISOString().slice(0, 10)}: ` +
        `H4 resistance=${result.h4Levels.resistance.toFixed(5)} (${result.resistanceState}) support=${result.h4Levels.support.toFixed(5)} (${result.supportState})`,
    );
  } else {
    console.log('No reference-week H4 candles found.');
  }
  if (result.d1Levels) {
    console.log(`D1 resistance=${result.d1Levels.resistance.toFixed(5)} support=${result.d1Levels.support.toFixed(5)} (confluence check)`);
  } else {
    console.log('No reference-week D1 candles found — no level can pass the confluence check right now.');
  }
  if (result.currentPrice) {
    console.log(`Current price: bid=${result.currentPrice.bid} ask=${result.currentPrice.ask}`);
  }
  console.log(`Mechanical decision: ${result.decision.action}`);
  console.log(`Mechanical reasoning: ${result.decision.reasoning}`);
}

function printAi(ai: Awaited<ReturnType<AutonomousAiDecisionService['evaluate']>>['ai']): void {
  if (!ai.aiDecision && !ai.aiRejected) {
    console.log('Mechanical engine said HOLD — the AI confirmation layer was never invoked (by design, see the service\'s own comment).');
  } else if (ai.aiRejected) {
    console.log(`AI response REJECTED by validation: ${ai.aiRejectionReason}`);
  } else {
    console.log(`AI decision: ${ai.aiDecision!.action} (confidence=${ai.aiDecision!.confidence})`);
    console.log(`AI reasoning: ${ai.aiDecision!.reasoning}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
