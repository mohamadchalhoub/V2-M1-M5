/**
 * Migration to `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Usage:
 *   npm run xauusd-rsi:migrate            inspect only, change nothing
 *   npm run xauusd-rsi:migrate -- --apply retire unsent old intentions
 *
 * What it does, and deliberately does not do:
 *
 * - **Retires UNSENT old-strategy entry intentions** (`PENDING` rows that no
 *   collector ever claimed) with an audit reason. These are safe to retire
 *   because nothing was sent; leaving them would be the one way a retired
 *   strategy's order could still reach the broker if a route were ever
 *   re-enabled.
 * - **Never touches a SENT or otherwise uncertain row.** Those are reported
 *   for reconciliation against the broker's own deal history. Marking one
 *   failed would free the occupancy slot on an assumption.
 * - **Never closes a position.** Migration is not a reason to close anything
 *   (spec §10). Existing positions keep their identity and their original
 *   protective management; the Friday deadline applies to them as owned
 *   exposure, which the liquidation worker handles on its own schedule.
 * - **Never relabels ownership.** A position opened by a retired strategy is
 *   reported as that strategy's, not adopted by the new one.
 *
 * Read-only by default so it can be run safely at any time.
 */
import { PrismaClient } from '@prisma/client';
import { describeOwnership, ownerForMagic } from '../src/xauusd-rsi/ownership';
import { extractMagic } from '../src/xauusd-rsi/account-state.service';
import { SPEC, SPEC_HASH } from '../src/xauusd-rsi/spec';
import { beirutLabel } from '../src/xauusd-rsi/time';
import { nextFridayDeadlineAt } from '../src/xauusd-rsi/schedule';

const APPLY = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  const now = Date.now();

  console.log('='.repeat(78));
  console.log(`Migration to ${SPEC.strategyVersion} (spec ${SPEC_HASH})`);
  console.log(`Mode: ${APPLY ? 'APPLY — unsent old intentions will be retired' : 'INSPECT ONLY — nothing will be changed'}`);
  console.log(`Now:  ${beirutLabel(now)}`);
  console.log('='.repeat(78));

  // --- 1. Old-strategy entry intentions. ---
  const legacyPending = await prisma.autonomousDecision.findMany({
    where: { orderStatus: 'PENDING' },
    orderBy: { evaluatedAt: 'asc' },
  });
  const legacySent = await prisma.autonomousDecision.findMany({
    where: { orderStatus: 'SENT' },
    orderBy: { evaluatedAt: 'asc' },
  });

  console.log(`\n[1] Retired-strategy entry intentions (autonomous_decisions)`);
  console.log(`    UNSENT (PENDING): ${legacyPending.length}`);
  for (const d of legacyPending) {
    console.log(`      ${d.id}  ${d.symbol} ${d.action}  evaluated ${d.evaluatedAt.toISOString()}`);
  }
  console.log(`    SENT / uncertain: ${legacySent.length}${legacySent.length > 0 ? '  <-- NEEDS RECONCILIATION, not retirement' : ''}`);
  for (const d of legacySent) {
    console.log(`      ${d.id}  ${d.symbol} ${d.action}  ticket=${d.mt5Ticket ?? 'none'}  evaluated ${d.evaluatedAt.toISOString()}`);
    console.log('        -> Confirm against the broker’s own deal history before assuming anything about it.');
  }

  if (APPLY && legacyPending.length > 0) {
    const reason =
      `Retired by the migration to ${SPEC.strategyVersion} at ${new Date(now).toISOString()}: ` +
      'the strategy that queued this entry is no longer enabled and its submission route is disabled. ' +
      'This row was never sent to the broker.';
    const result = await prisma.autonomousDecision.updateMany({
      where: { orderStatus: 'PENDING' },
      data: { orderStatus: 'NONE', riskManagerApproved: false, riskManagerRejectionReason: reason },
    });
    console.log(`    APPLIED: retired ${result.count} unsent intention(s) with an audit reason.`);
  }

  // Trend-breakout's own decision table, same treatment.
  const tbPending = await prisma.trendBreakoutDecision.count({ where: { orderStatus: 'PENDING' } });
  const tbSent = await prisma.trendBreakoutDecision.count({ where: { orderStatus: 'SENT' } });
  console.log(`\n    trend_breakout_decisions: PENDING=${tbPending} SENT=${tbSent}`);
  if (APPLY && tbPending > 0) {
    const result = await prisma.trendBreakoutDecision.updateMany({
      where: { orderStatus: 'PENDING' },
      data: {
        orderStatus: 'NONE',
        rejectionReason: `Retired by the migration to ${SPEC.strategyVersion} at ${new Date(now).toISOString()} — never sent, and the strategy is no longer enabled.`,
      },
    });
    console.log(`    APPLIED: retired ${result.count} unsent trend-breakout intention(s).`);
  }

  // --- 2. Existing XAUUSD exposure and its ownership. ---
  const positions = await prisma.position.findMany({ where: { symbol: SPEC.symbol, status: 'OPEN' } });
  console.log(`\n[2] Open ${SPEC.symbol} positions: ${positions.length}`);
  for (const p of positions) {
    const magic = extractMagic(p.rawPayload);
    const owner = ownerForMagic(magic);
    console.log(`      ticket=${p.externalPositionId} side=${p.side} vol=${p.volume} open=${p.openPrice} SL=${p.stopLoss ?? 'NONE'} TP=${p.takeProfit ?? 'NONE'}`);
    console.log(`        ownership: ${describeOwnership(magic)}`);
    if (owner && !owner.isActiveStrategy) {
      console.log(`        -> Keeps its original $${owner.stopLossUsd} protective distance. NOT adopted by the new strategy, NOT re-protected at $${SPEC.brackets.stopLossUsd}.`);
    }
    if (!owner) {
      console.log('        -> FOREIGN: counted for occupancy and displayed, but never closed or modified by this application.');
    }
    console.log('        -> Not closed by this migration. The Friday deadline applies to owned exposure via the liquidation worker.');
  }

  // Non-gold positions, reported so nothing is a surprise later.
  const otherPositions = await prisma.position.findMany({ where: { status: 'OPEN', NOT: { symbol: SPEC.symbol } } });
  if (otherPositions.length > 0) {
    console.log(`\n    Open positions on other symbols: ${otherPositions.length} (untouched, outside this strategy's scope)`);
    for (const p of otherPositions) console.log(`      ${p.symbol} ticket=${p.externalPositionId} side=${p.side} vol=${p.volume}`);
  }

  // --- 3. New strategy's own state. ---
  const rsiDecisions = await prisma.xauusdRsiDecision.count();
  const rsiInFlight = await prisma.xauusdRsiDecision.count({ where: { orderStatus: { in: ['PENDING', 'SENT', 'UNKNOWN'] } } });
  console.log(`\n[3] New strategy decisions: ${rsiDecisions} total, ${rsiInFlight} in flight`);

  // --- 4. Historical record preserved. ---
  const trades = await prisma.trade.count();
  const legacyTotal = await prisma.autonomousDecision.count();
  const tbTotal = await prisma.trendBreakoutDecision.count();
  console.log(`\n[4] Historical record (preserved, never deleted)`);
  console.log(`      trades:                      ${trades}`);
  console.log(`      autonomous_decisions:        ${legacyTotal}`);
  console.log(`      trend_breakout_decisions:    ${tbTotal}`);

  // --- 5. Next obligations. ---
  const deadline = nextFridayDeadlineAt(now);
  console.log(`\n[5] Next Friday closure deadline: ${deadline ? beirutLabel(deadline) : 'unknown'}`);
  console.log('    This can only be met while the watch process is running. Nothing performs it automatically.');

  if (!APPLY) {
    console.log('\nRe-run with --apply to retire the unsent intentions listed above.');
  }

  await prisma.$disconnect();
}

void main();
