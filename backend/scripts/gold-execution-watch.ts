/**
 * Manually-invoked (NOT scheduled — same deliberate posture as every other
 * coordinator in this codebase) single watch cycle for the gold execution
 * strategy: loads confirmed-retest-v2 data, advances its replay state,
 * finds any newly-actionable live event, and — depending on
 * GOLD_EXECUTION_MODE (OFF/SHADOW/DEMO) — logs or queues a decision.
 *
 * Usage: `npx tsx scripts/gold-execution-watch.ts` (reads GOLD_EXECUTION_MODE
 * from the environment; defaults to OFF, which will run the cycle and print
 * what it *would* have evaluated, but queue nothing).
 */
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { GoldAccountStateService } from '../src/gold-execution/gold-account-state.service';
import { GoldExecutionCoordinatorService } from '../src/gold-execution/gold-execution-coordinator.service';
import { GoldRuntimeSettingsService } from '../src/gold-execution/gold-runtime-settings.service';
import { getGoldExecutionMode } from '../src/gold-execution/gold-execution-mode';
import { GOLD_MAX_ENTRY_DEVIATION_POINTS, GOLD_POINT_SIZE, GOLD_SYMBOL } from '../src/gold-execution/gold-safety-constants';
import { GoldWatchStore, runGoldWatchCycle } from '../src/gold-execution/gold-signal-source';

async function main() {
  const prisma = new PrismaClient();
  try {
    // Gold trades on MT5 only — explicit platform filter, NOT "first
    // created" (this deployment holds an XTB account too; picking the
    // wrong one was a real bug found live during this task's own
    // verification pass — see the trade_mode-mapping-fix commit).
    const account = await prisma.tradingAccount.findFirst({ where: { platform: 'MT5' }, orderBy: { createdAt: 'asc' } });
    if (!account) {
      console.log(JSON.stringify({ error: 'no trading account found — nothing to evaluate' }));
      return;
    }

    const accountState = new GoldAccountStateService(prisma as any);
    const coordinator = new GoldExecutionCoordinatorService(prisma as any, new GoldRuntimeSettingsService());
    const store = new GoldWatchStore(process.env.GOLD_RESEARCH_STATE_DIR ?? resolve(__dirname, '..', 'research-state', 'gold-live-watch'));

    const mode = getGoldExecutionMode();
    console.log(`gold-execution-watch: mode=${mode} account=${account.id} startedAt=${new Date().toISOString()}`);

    const result = await runGoldWatchCycle({
      prisma,
      coordinator,
      store,
      nowT: Date.now(),
      accountId: account.id,
      buildContext: async () => ({
        accountInfo: await accountState.resolveAccountRiskInfo(account.id),
        occupancy: await accountState.resolveOccupancy(account.id),
        volumeConstraints: await accountState.resolveVolumeConstraints(),
        maxEntryDeviationPoints: GOLD_MAX_ENTRY_DEVIATION_POINTS,
        goldPointSize: GOLD_POINT_SIZE,
      }),
      getExecutablePrice: async (direction) => {
        const tick = await prisma.liveTick.findUnique({ where: { symbol: GOLD_SYMBOL } });
        if (!tick) return null;
        // Buying pays the ask, selling receives the bid — same convention executor.py's own _build_bracket_request uses.
        return direction === 'BUY' ? tick.ask.toNumber() : tick.bid.toNumber();
      },
      getLiveQuote: async () => {
        const tick = await prisma.liveTick.findUnique({ where: { symbol: GOLD_SYMBOL } });
        if (!tick) return null;
        return { bid: tick.bid.toNumber(), atT: tick.tickAt.getTime() };
      },
    });

    console.log(JSON.stringify({
      mode,
      actionableEventCount: result.actionableEvents.length,
      actionableEventIds: result.actionableEvents.map((e) => e.id),
      // Audit-only — see GoldWatchCycleResult's own doc comment. Never an order.
      auditOnlyDecisionIds: result.auditOnlyDecisionIds,
      liveTouchEventCount: result.liveTouchEvents.length,
      liveTouchOutsideWindowCount: result.liveTouchOutsideWindow.length,
      liveTouchSkippedNoExecutablePriceCount: result.liveTouchSkippedNoExecutablePrice.length,
      liveTouchResults: result.liveTouchResults.map((r) => ({
        eventId: r.event.id,
        signal: r.signal,
        coordinatorMode: r.coordinatorResult.mode,
        verdictApproved: r.coordinatorResult.verdict?.approved ?? null,
        verdictRejectionReason: r.coordinatorResult.verdict?.rejectionReason ?? null,
        queuedDecisionId: r.coordinatorResult.queuedDecisionId,
      })),
      liveDetectionNotes: result.liveDetectionNotes,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('gold-execution-watch failed:', err);
  process.exitCode = 1;
});
