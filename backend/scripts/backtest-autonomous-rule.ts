/**
 * Phase 3 — AUTONOMOUS_DEMO_TRADING_PLAN.md §7: the rules-only backtest,
 * required before any AI, execution, or dashboard code is built, and a
 * go/no-go gate — if this isn't at least breakeven after a modeled spread,
 * the plan says stop and revisit the rule with the friend rather than
 * proceed. Replays `evaluateAutonomousRule` (the exact same pure function a
 * live dry-run would call — see backtest-simulator.ts's own module comment)
 * over this database's full EURUSD history: H4 candles for the friend's
 * Rule 4 weekly levels, M15 candles (the finest timeframe with FULL
 * multi-year coverage in this database — M5 only goes back ~1.3 years) for
 * entry-scanning and SL/TP resolution.
 *
 * Reconciliation audit, 2nd pass: this script now reports THREE things,
 * clearly labeled, never conflated:
 *   1. The LEGACY engine (`runBacktest`) — kept only for reproducibility of
 *      the originally-reported numbers. Known to look ahead and to mis-price
 *      short exits (see backtest-simulator.ts).
 *   2. The CORRECTED engine (`runBacktestNoLookahead`) — fixes both defects.
 *      This is the number to trust.
 *   3. A deterministic APPROVE-ALL parity check
 *      (`runBacktestWithConfirmation` with a stub hook) proving, by
 *      assertion in `backtest-simulator.spec.ts` AND by direct comparison
 *      printed here, that the AI-assisted path and the mechanical path are
 *      the SAME simulation loop — not two independently-written scans that
 *      happen to differ by a couple of candidates.
 *
 * Deliberately a CLI script, not a new HTTP endpoint — same reasoning as
 * evaluate-autonomous-rule.ts and trigger-daily-analysis.ts.
 *
 * Run: npm run backtest-autonomous-rule
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { loadAiConfig } from '../src/ai/ai.config';
import { HistoricalPatternSummaryService } from '../src/ai/historical-pattern-summary.service';
import { TradeAlignmentService } from '../src/historical-charts/trade-alignment.service';
import { loadAutonomousRulesConfig } from '../src/autonomous/autonomous-rules.config';
import { AutonomousAiContext } from '../src/autonomous/autonomous-ai-decision.types';
import { buildAutonomousAiProvider } from '../src/autonomous/autonomous-ai-provider.factory';
import { validateAutonomousAiDecision } from '../src/autonomous/validate-autonomous-ai-decision';
import {
  BacktestCandidate,
  BacktestResult,
  runBacktest,
  runBacktestNoLookahead,
  runBacktestWithConfirmation,
} from '../src/autonomous/backtest-simulator';
import { HistoricalCandleService } from '../src/market-data/historical-candle.service';

const SYMBOL = 'EURUSD';
// Typical EURUSD retail spread order of magnitude — a placeholder, not a
// broker-verified figure (AUTONOMOUS_DEMO_TRADING_PLAN.md §13.3's "spread/
// slippage modeling" item). Applied only to entries, per
// backtest-simulator.ts's own documented simplification.
const ASSUMED_SPREAD_POINTS = 15;

function fmt(n: number | null, digits = 2): string {
  return n === null ? 'n/a' : n.toFixed(digits);
}

function report(label: string, result: BacktestResult): void {
  console.log(`\n=== ${label} ===`);
  console.log(`Total signals: ${result.totalTrades} (closed: ${result.wins + result.losses}, still open at end of data: ${result.openAtEnd})`);
  console.log(`Wins: ${result.wins}  Losses: ${result.losses}  Win rate: ${fmt(result.winRate !== null ? result.winRate * 100 : null)}%`);
  console.log(`Avg win: ${fmt(result.avgWinPoints)} points  Avg loss: ${fmt(result.avgLossPoints)} points`);
  console.log(`Profit factor: ${result.profitFactor === Infinity ? 'infinite (no losses)' : fmt(result.profitFactor)}`);
  console.log(`Total P&L: ${fmt(result.totalPnlPoints)} points  Max drawdown: ${fmt(result.maxDrawdownPoints)} points`);
  console.log(`Per-trade Sharpe (NOT annualized, tiny sample): ${fmt(result.sharpeRatioPerTrade, 3)}`);
  // 0.01 lot ≈ $0.01 per EURUSD point — approximate, no commission modeled beyond the assumed spread.
  console.log(`Approx P&L at 0.01 lot: $${fmt(result.totalPnlPoints * 0.01)}`);
}

/** Deep-equal-ish comparison for the parity check's own console output — trades arrays included, since "byte-identical" is the actual claim being demonstrated, not just matching summary stats. */
function resultsAreIdentical(a: BacktestResult, b: BacktestResult): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const config = new ConfigService(process.env);

  try {
    const rulesConfig = loadAutonomousRulesConfig(config);
    const candleService = new HistoricalCandleService(prisma as any);

    const earliestH4 = await candleService.getLatestOpenTime(SYMBOL, 'H4');
    if (!earliestH4) {
      console.log('No H4 candles found — nothing to backtest.');
      return;
    }

    // Full available range, all three timeframes — the DB currently holds
    // ~2.75 years, comfortably over the plan's 2-year minimum.
    const from = new Date('2000-01-01T00:00:00Z');
    const to = new Date();
    console.log(`Fetching full EURUSD H4 + D1 + M15 history up to ${to.toISOString()}...`);
    const [h4Candles, d1Candles, m15Candles] = await Promise.all([
      candleService.getCandlesInRange(SYMBOL, 'H4', from, to),
      candleService.getCandlesInRange(SYMBOL, 'D1', from, to),
      candleService.getCandlesInRange(SYMBOL, 'M15', from, to),
    ]);
    const dataVersionTag = `M15 rows=${m15Candles.length}, range=${m15Candles[0]?.openTime.toISOString()}..${m15Candles.at(-1)?.openTime.toISOString()}`;
    console.log(`H4 candles: ${h4Candles.length} (${h4Candles[0]?.openTime.toISOString()} .. ${h4Candles.at(-1)?.openTime.toISOString()})`);
    console.log(`D1 candles: ${d1Candles.length} (${d1Candles[0]?.openTime.toISOString()} .. ${d1Candles.at(-1)?.openTime.toISOString()})`);
    console.log(`M15 candles: ${m15Candles.length} (${m15Candles[0]?.openTime.toISOString()} .. ${m15Candles.at(-1)?.openTime.toISOString()})`);
    console.log(`Config: ${JSON.stringify(rulesConfig)}, assumed spread: ${ASSUMED_SPREAD_POINTS} points`);
    console.log(`Data version identifier (for reproduction): ${dataVersionTag}`);

    // ---- 1. LEGACY engine — reproduced for the record only ----
    const legacyZeroSpread = runBacktest(h4Candles, d1Candles, m15Candles, rulesConfig, 0);
    report('⚠ LEGACY engine — ZERO spread (has look-ahead + short-side pricing defects, see backtest-simulator.ts)', legacyZeroSpread);
    const legacyWithSpread = runBacktest(h4Candles, d1Candles, m15Candles, rulesConfig, ASSUMED_SPREAD_POINTS);
    report(`⚠ LEGACY engine — with assumed ${ASSUMED_SPREAD_POINTS}pt spread (kept only to reproduce the originally-reported numbers)`, legacyWithSpread);

    // ---- 2. CORRECTED engine — the number to trust ----
    const correctedZeroSpread = await runBacktestNoLookahead(h4Candles, d1Candles, m15Candles, rulesConfig, 0);
    report('CORRECTED engine — ZERO spread (no look-ahead, side-correct pricing)', correctedZeroSpread);
    const correctedWithSpread = await runBacktestNoLookahead(h4Candles, d1Candles, m15Candles, rulesConfig, ASSUMED_SPREAD_POINTS);
    report(`CORRECTED engine — with assumed ${ASSUMED_SPREAD_POINTS}pt spread (TRUST THIS ONE)`, correctedWithSpread);

    console.log(
      `\nLegacy vs. corrected, same data/config/spread: legacy P&L=${fmt(legacyWithSpread.totalPnlPoints)}pt (n=${legacyWithSpread.totalTrades}) ` +
        `vs. corrected P&L=${fmt(correctedWithSpread.totalPnlPoints)}pt (n=${correctedWithSpread.totalTrades}). Do NOT describe this difference as ` +
        `"minor" without reading both numbers above — it is reported, not asserted, here.`,
    );

    console.log(
      `\nGo/no-go gate (plan §7.8), evaluated against the CORRECTED engine: ${correctedWithSpread.totalPnlPoints > 0 ? 'Positive' : 'NOT positive'} ` +
        `total P&L after the assumed spread. ${
          correctedWithSpread.totalPnlPoints > 0
            ? 'This does not mean "proceed" by itself — see the honest caveats below.'
            : 'Negative historical result for the CURRENT implementation of the friend\'s rule. This does not establish the intended strategy is unprofitable — see AUTONOMOUS_RULE_ENGINE_SPEC.md for confirmed-vs-interpreted rule elements still pending his clarification.'
        }`,
    );

    // ---- 3. Deterministic approve-all parity demonstration (no API calls) ----
    console.log(`\n=== Approve-all parity check (no AI, no API calls — proves the AI-assisted path shares this exact simulation loop) ===`);
    const approveAllResult = await runBacktestWithConfirmation(h4Candles, d1Candles, m15Candles, rulesConfig, ASSUMED_SPREAD_POINTS, async () => true);
    const identical = resultsAreIdentical(approveAllResult, correctedWithSpread);
    console.log(`runBacktestWithConfirmation(..., approveAll) === runBacktestNoLookahead(...): ${identical ? 'IDENTICAL (byte-for-byte)' : 'DIFFERS — this would be a real bug'}`);
    if (!identical) {
      console.log('First divergence check — trade counts:', approveAllResult.totalTrades, 'vs', correctedWithSpread.totalTrades);
    }

    console.log(`\n=== Sensitivity sweep (CORRECTED engine) — how fragile is the result? ===`);
    console.log('(entry-retrace points, confluence-tolerance points) x (assumed spread points): total P&L, [win rate%, trades]');
    for (const retrace of [30, 50, 75]) {
      for (const confluence of [30, 50, 100]) {
        const row: string[] = [];
        for (const spread of [0, 10, 15, 20]) {
          const r = await runBacktestNoLookahead(h4Candles, d1Candles, m15Candles, { ...rulesConfig, entryRetracePoints: retrace, confluenceTolerancePoints: confluence }, spread);
          row.push(`${r.totalPnlPoints.toFixed(0)} [${r.winRate !== null ? (r.winRate * 100).toFixed(0) : 'n/a'}%,${r.totalTrades}]`);
        }
        console.log(`retrace=${retrace}, confluence=${confluence}: ` + row.join('  |  '));
      }
    }

    const aiConfig = loadAiConfig(config);
    const skipAi = process.env.SKIP_AI_ASSISTED_BACKTEST === 'true';
    if (aiConfig.enabled && !skipAi) {
      console.log(`\n=== AI-assisted backtest (real ${aiConfig.provider}/${aiConfig.model} calls, one per mechanical candidate, via the SAME engine as the mechanical run above) ===`);
      console.log(`Provider/model identity for this run: provider=${aiConfig.provider} model=${aiConfig.model} promptVersion=see autonomous-ai-prompt.ts AUTONOMOUS_SYSTEM_PROMPT (unversioned; hash the file if you need a stable id) temperature=0`);
      const tradeAlignment = new TradeAlignmentService(prisma as any, candleService);
      const historicalPattern = await new HistoricalPatternSummaryService(tradeAlignment).build();
      const aiProvider = buildAutonomousAiProvider(aiConfig);

      let mechanicalCandidates = 0;
      let confirmed = 0;
      let vetoed = 0;
      let rejectedInvalid = 0;
      let rejectedQuota = 0;
      const sampleRejectionReasons: string[] = [];
      const AI_CALL_PACING_MS = 5000;
      const CONSECUTIVE_RATE_LIMIT_ABORT_THRESHOLD = 4;
      let consecutiveRateLimitFailures = 0;
      let quotaExhausted = false;

      const aiAssistedResult = await runBacktestWithConfirmation(h4Candles, d1Candles, m15Candles, rulesConfig, ASSUMED_SPREAD_POINTS, async (candidate: BacktestCandidate) => {
        mechanicalCandidates++;
        if (quotaExhausted) return false; // already aborted — treat remaining candidates as vetoed, not silently skipped
        await new Promise((resolve) => setTimeout(resolve, AI_CALL_PACING_MS));

        const context: AutonomousAiContext = {
          now: candidate.now,
          currentPrice: candidate.currentPrice,
          h4Levels: candidate.h4Levels,
          d1Levels: candidate.d1Levels,
          supportState: candidate.supportState,
          resistanceState: candidate.resistanceState,
          mechanicalCandidateLevel: candidate.levelUsed,
          historicalPattern,
          upcomingEvents: [], // no historical event archive to replay against — disclosed, not fabricated
          recentNews: [],
          ordersPlacedToday: 0,
        };

        try {
          const raw = await aiProvider.decide(context);
          const aiDecision = validateAutonomousAiDecision(raw, rulesConfig);
          consecutiveRateLimitFailures = 0;
          if (aiDecision.action === candidate.action) {
            confirmed++;
            return true;
          }
          vetoed++;
          return false;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/\b429\b|quota|rate limit|too many requests/i.test(message)) {
            rejectedQuota++;
            consecutiveRateLimitFailures++;
            if (consecutiveRateLimitFailures >= CONSECUTIVE_RATE_LIMIT_ABORT_THRESHOLD) quotaExhausted = true;
          } else {
            rejectedInvalid++;
            consecutiveRateLimitFailures = 0;
          }
          if (sampleRejectionReasons.length < 5) sampleRejectionReasons.push(message);
          return false; // malformed output / unavailable AI / stale inputs → no permission to open, never a fallback approval
        }
      });

      if (quotaExhausted) {
        console.log(
          `\nABORTED — the AI provider's quota/rate limit was hit (sample error: "${sampleRejectionReasons[0]}"). ` +
            `Stopped calling the API rather than burning through further candidates. Confirmed ${confirmed}, vetoed ${vetoed}, ` +
            `rejected(quota) ${rejectedQuota}, rejected(invalid) ${rejectedInvalid} before stopping. These numbers are NOT a real ` +
            `rules-vs-AI comparison — rerun once quota is available.`,
        );
      } else if (rejectedInvalid + rejectedQuota > 0) {
        console.log(`\nNote: ${rejectedInvalid + rejectedQuota} AI response(s) were rejected (${rejectedInvalid} invalid, ${rejectedQuota} quota/rate-limit). Sample reasons: ${sampleRejectionReasons.join(' | ')}`);
      }

      report(`AI-assisted backtest — CORRECTED engine, ${ASSUMED_SPREAD_POINTS}pt spread`, aiAssistedResult);
      console.log(`Mechanical candidates seen: ${mechanicalCandidates}. AI confirmed ${confirmed}, vetoed ${vetoed}, rejected-invalid ${rejectedInvalid}, rejected-quota ${rejectedQuota}.`);
      console.log(
        `Population note: mechanicalCandidates above is now computed by the SAME loop as the mechanical-only run — any difference from ` +
          `correctedWithSpread.totalTrades (${correctedWithSpread.totalTrades}) is attributable ONLY to AI confirm/veto decisions, never to a ` +
          `second, differently-implemented candidate scan.`,
      );

      if (!quotaExhausted) {
        const pf = aiAssistedResult.profitFactor;
        const pfIsProfitable = pf !== null && pf !== Infinity && pf > 1;
        console.log(
          `\nRules-only vs. AI-assisted (CORRECTED engine): ${
            aiAssistedResult.totalPnlPoints > correctedWithSpread.totalPnlPoints ? 'AI-assisted had a smaller loss / larger gain this run.' : 'Rules-only did better (or equal) this run.'
          } Profit factor ${fmt(pf)} is ${pfIsProfitable ? 'ABOVE 1.0 (net winning on this sample)' : 'at or below 1.0 (net losing or breakeven) — do NOT describe this as "profitable" regardless of any improvement over the rules-only run'}. ` +
            `This backtest cannot see genuinely historical news/events, so treat any difference as reflecting price/level/pattern judgment only.`,
        );
      }
    } else if (skipAi) {
      console.log('\nSKIP_AI_ASSISTED_BACKTEST=true — skipping the real-API AI-assisted section this run (approve-all parity check above already exercises the shared engine without spending quota).');
    } else {
      console.log('\nAI_ENABLED=false — skipping the AI-assisted backtest (mechanical results above stand alone).');
    }

    await reportFriendComparison(prisma);

    console.log(
      '\nHonest caveats (do not skip these when reading the numbers above):\n' +
        '- Two parameters here are still this project\'s own placeholder reconciliations, not the\n' +
        "  friend's stated numbers: levelBreakOvershootPoints and confluenceTolerancePoints — see\n" +
        '  AUTONOMOUS_RULE_ENGINE_SPEC.md §2.4/§2.5. A different answer to either could change this\n' +
        '  result completely, in either direction.\n' +
        '- The H4/D1 confluence filter is a confirmed near-no-op (compares a week\'s H4 extreme to a\n' +
        '  D1 "level" computed over the SAME week, which is mathematically almost the same number) —\n' +
        '  see the audit report. Not fixed here; needs the friend\'s definition of an independent D1 level.\n' +
        '- No broker minimum-distance (freeze level) or maximum-spread guard is modeled — a real broker\n' +
        '  might reject some of these entries outright.\n' +
        '- No weekend-gap handling is modeled — some simulated entries near a Friday close/Monday open\n' +
        '  might not have filled at the assumed price in reality.\n' +
        '- Synthetic ask pricing (bid + fixed spread) approximates short-side execution; no historical\n' +
        '  bid/ask tick archive exists in this database to do better.\n' +
        '- This is a walk-through, not a walk-FORWARD validation, and the same data has already\n' +
        '  informed which retrace/confluence values were chosen — it cannot be called out-of-sample.\n' +
        '  The only genuinely untouched data is whatever trades happen after the spec is frozen with\n' +
        "  the friend's answers.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function reportFriendComparison(prisma: PrismaClient): Promise<void> {
  // Plan §7.5 — replay validation against the friend's own trades. See
  // AUTONOMOUS_RULE_ENGINE_SPEC.md §2.1: only 648 of the friend's 865
  // closed positions are EURUSD, and only 249 of those have both SL and TP
  // recorded — this is a rough sanity check against the friend's GENERAL
  // trading (up to 32 EURUSD positions opened on a single date exist in
  // this same history — incompatible with a 1-trade/day weekly rule), not
  // proof this rule reproduces trades that specifically followed it.
  const rows = await prisma.$queryRaw<{ n: bigint; avg_sl: number | null; avg_tp: number | null; median_sl: number | null; median_tp: number | null }[]>`
    SELECT
      count(*) AS n,
      avg(abs(price - stop_loss) * 100000) AS avg_sl,
      avg(abs(take_profit - price) * 100000) AS avg_tp,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(price - stop_loss) * 100000) AS median_sl,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(take_profit - price) * 100000) AS median_tp
    FROM trades t
    JOIN trading_accounts a ON a.id = t.account_id
    WHERE a.platform = 'XTB' AND t.symbol = 'EURUSD' AND t.deal_entry = 'IN' AND t.stop_loss IS NOT NULL AND t.take_profit IS NOT NULL
  `;
  const row = rows[0];
  console.log(`\n=== Friend's real EURUSD trades with SL+TP recorded (sanity check, plan §7.5) ===`);
  console.log(`n=${row.n}  avg SL=${fmt(row.avg_sl)}pt  avg TP=${fmt(row.avg_tp)}pt  median SL=${fmt(row.median_sl)}pt  median TP=${fmt(row.median_tp)}pt`);
  console.log('This is a ratio of AVERAGE RECORDED distances, not an average per-trade or realized reward:risk — do not conflate the two.');
  console.log('Compare against this run\'s configured 180/180pt bracket — see AUTONOMOUS_RULE_ENGINE_SPEC.md §2.1 for the full discussion.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
