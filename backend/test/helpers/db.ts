import { PrismaClient } from '@prisma/client';

// Deletes in FK-safe (children-first) order. Run between every test so
// each test starts from a genuinely empty, known state — repeatable, no
// ordering dependencies between tests.
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  // Gold execution isolation tables — no FKs to anything else, but must
  // still be cleared between tests (their absence here was a real test-
  // isolation bug: leftover rows from an earlier test's ticket/dedupKey
  // silently changed a LATER test's behavior, e.g. a stale MISSING_PROTECTION
  // notification row made a fresh incident look already-alerted).
  // Active-strategy tables. Same isolation bug as the gold tables below had:
  // a liquidation item left behind by an earlier test is picked up by a later
  // one as an already-SUBMITTED attempt, which then suppresses the close
  // request that test was written to observe. Neither table has an FK to
  // anything cleared later in this function, so they go first.
  // xauusd-m1-m5-rsi-threshold-v2 tables. Cleared first, children before
  // parents: slot locks and the volume audit reference decisions and the
  // account, and a leftover slot lock from an earlier test would make a later
  // one see a timeframe as permanently occupied.
  await prisma.xauusdM1M5SlotLock.deleteMany();
  await prisma.xauusdM1M5CloseRequest.deleteMany();
  await prisma.xauusdM1M5ProtectionRequest.deleteMany();
  await prisma.xauusdM1M5Mt5Snapshot.deleteMany();
  // No FK to anything, which is exactly why it is easy to forget -- and a
  // leftover row here is not inert: the unique dedupKey makes an earlier
  // test's notification silently suppress a later test's send, so the later
  // test observes nothing and passes for the wrong reason.
  await prisma.xauusdM1M5TelegramNotification.deleteMany();
  await prisma.xauusdM1M5DirectionalLock.deleteMany();
  await prisma.xauusdM1M5ProcessedClosure.deleteMany();
  await prisma.xauusdM1M5ReportPeriod.deleteMany();
  await prisma.xauusdM1M5VolumeAudit.deleteMany();
  await prisma.xauusdM1M5VolumeSetting.deleteMany();
  await prisma.xauusdM1M5Decision.deleteMany();
  await prisma.xauusdRsiLiquidationItem.deleteMany();
  await prisma.xauusdRsiDecision.deleteMany();
  // Retired-strategy decisions. `accountId` is SetNull on account deletion, so
  // without this the rows survive as orphans and accumulate across tests.
  await prisma.autonomousDecision.deleteMany();
  await prisma.goldProtectionRestoreRequest.deleteMany();
  await prisma.goldCloseRequest.deleteMany();
  await prisma.goldTelegramNotification.deleteMany();
  await prisma.trendBreakoutCloseRequest.deleteMany();
  await prisma.liveTick.deleteMany();
  await prisma.trendBreakoutSlotLock.deleteMany();
  await prisma.trendBreakoutDecision.deleteMany();
  await prisma.trendBreakoutEmergencyIncident.deleteMany();
  await prisma.trendBreakoutRiskState.deleteMany();
  await prisma.trendBreakoutVolumeAudit.deleteMany();
  await prisma.trendBreakoutVolumeSetting.deleteMany();
  await prisma.symbolMetadata.deleteMany();
  await prisma.historicalCandle.deleteMany();
  // Gold historical-collection phase — no FKs, but must still be cleared
  // between tests same as historicalCandle above.
  await prisma.historicalTick.deleteMany();
  await prisma.backfillInterval.deleteMany();
  await prisma.marketEvent.deleteMany();
  await prisma.healthIncident.deleteMany();
  await prisma.healthStatus.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.aiAnalysis.deleteMany();
  await prisma.alertDelivery.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.ruleState.deleteMany();
  await prisma.ruleDefinition.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.position.deleteMany();
  await prisma.accountSnapshot.deleteMany();
  await prisma.collectorHeartbeat.deleteMany();
  await prisma.syncCursor.deleteMany();
  await prisma.apiCredential.deleteMany();
  await prisma.tradingAccount.deleteMany();
  await prisma.user.deleteMany();
}
