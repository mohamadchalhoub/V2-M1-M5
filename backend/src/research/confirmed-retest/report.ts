/**
 * research/confirmed-retest/report — machine-readable run artifacts (JSON,
 * CSV) and a plain-language REPORT.md. Pure formatting; the only I/O is the
 * final directory write.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunOutputs } from './pipeline';
import { SPEC, SPEC_HASH } from './spec';
import type { EventBucket } from './statistics';
import { iso } from './time';
import type { FirstReturnEvent, Level, PivotRecord } from './types';

export interface ManifestExtras {
  runId: string;
  runCommand: string;
  generatedAtUtc: string;
  gitCommit: string;
  gitDirty: boolean;
  dataHash: string;
  provenance: unknown;
  mode: 'HISTORICAL_STUDY' | 'WATCH_ONLY';
}

const usdStr = (units: number | null | undefined) => (units === null || units === undefined ? '' : (units / 100).toFixed(2));

function csv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n') + '\n';
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function levelRows(levels: Level[]) {
  return levels.map((l) => ({
    id: l.id,
    role: l.role,
    price: usdStr(l.price),
    generation: l.generation,
    firstPivotId: l.firstPivotId,
    secondPivotId: l.secondPivotId,
    alternativeFirstPivotIds: l.alternativeFirstPivotIds.join(' '),
    activatedUtc: iso(l.activatedT),
    status: l.status,
    statusUtc: iso(l.statusT),
    h4BarsSinceActivation: l.barsSinceActivation,
    d1Agreement: l.d1Agreement,
    d1AgreementPivotUtc: iso(l.d1AgreementPivotT),
    firstReturnEventId: l.firstReturnEventId,
    laterBreakUtc: iso(l.laterBreakT),
  }));
}

export function eventRows(events: FirstReturnEvent[], decisions: Record<string, Record<string, Record<string, number>>>) {
  return events.map((e) => ({
    id: e.id,
    levelId: e.levelId,
    role: e.role,
    direction: e.direction,
    levelPrice: usdStr(e.levelPrice),
    generation: e.generation,
    period: e.period,
    kind: e.kind,
    touchIntervalStartUtc: iso(e.touchStartT),
    touchIntervalEndUtc: iso(e.touchEndT),
    touchResolution: e.touchResolution,
    beirutDate: e.beirut.date,
    beirutTime: `${String(e.beirut.hour).padStart(2, '0')}:${String(e.beirut.minute).padStart(2, '0')}`,
    inWindow: e.inWindow,
    eligible: e.eligible,
    ineligibleReason: e.ineligibleReason,
    gapId: e.gapId,
    selected: e.selection?.isSelected ?? null,
    bothSelectedSidesTouched: e.selection?.bothSelectedSidesTouched ?? null,
    selectionOrderKnown: e.selection?.orderKnown ?? null,
    d1Agreement: e.d1Agreement,
    levelActivatedUtc: iso(e.levelActivatedT),
    status: e.outcome?.status ?? null,
    entryBarReachable: e.outcome?.entryCandleReachable.join('/') ?? null,
    alternatives: e.outcome
      ? e.outcome.alternatives.map((a) => `${a.result}${a.exitBarT !== null ? `@${iso(a.exitBarT)}` : ''}${a.exitType === 'GAP_OPEN' ? `(gap-open ${usdStr(a.exitPrice)})` : ''}${a.gapId ? `(${a.gapId})` : ''}`).join(' | ') + (e.outcome.pendingRace ? ' | PENDING' : '')
      : null,
    tp: usdStr(e.outcome?.tp),
    sl: usdStr(e.outcome?.sl),
    maeUsdPerOz: e.outcome ? (e.outcome.maeUnits / 100).toFixed(2) : null,
    note: e.outcome?.note ?? null,
    paperPrimaryGross: decisions['ASSUMED_1000_PRIMARY|IDEALIZED_GROSS']?.[e.id] ?? null,
    paperSensitivityBase: decisions['ASSUMED_10000_SENSITIVITY|ASSUMED_BASE']?.[e.id] ?? null,
    observedAtUtc: iso(e.observedAtT),
  }));
}

function pivotRows(pivots: PivotRecord[]) {
  return pivots.map((p) => ({ id: p.id, role: p.role, price: usdStr(p.price), h4Index: p.index, barOpenUtc: iso(p.barT), confirmedAtUtc: iso(p.confirmT), qualified: p.qualified, usedByLevelId: p.usedByLevelId }));
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

function bucketLine(label: string, b: EventBucket): string {
  const c = b.counts;
  const wr = b.resolvedWinRate;
  const ci = wr.wilson95 ? `${pct(wr.wilson95[0])}–${pct(wr.wilson95[1])}` : 'n/a';
  return `| ${label} | ${b.eligibleEvents} | ${c.WIN} | ${c.LOSS} | ${c.AMBIGUOUS} | ${c.INDETERMINATE} | ${c.UNRESOLVED} | ${wr.numerator}/${wr.denominator} = ${pct(wr.rate)} | ${ci} | ${pct(b.allEligibleBounds.low)} – ${pct(b.allEligibleBounds.high)} |`;
}

export function renderReport(run: RunOutputs, extras: ManifestExtras): string {
  const es = run.eventStudy;
  const d = run.state.levels.diagnostics;
  const allLevels = Object.values(run.state.levels.levels);
  const studyLevels = allLevels.filter((l) => l.activatedT >= run.studyStartT);
  const activeAtStudyStart = allLevels.filter((l) => l.activatedT <= run.studyStartT && (l.statusT === null || l.statusT > run.studyStartT)).length;
  const header = '| Bucket | Eligible N | WIN | LOSS | AMBIG | INDET | UNRES | Resolved W/(W+L) | Wilson 95% | All-eligible W/N – (N−L)/N |\n|---|---|---|---|---|---|---|---|---|---|';
  const v = run.coverage.validations;
  const range = (r: [number, number] | null, money = false) => (r === null ? 'n/a' : r[0] === r[1] ? (money ? `$${r[0].toFixed(2)}` : `${+r[0].toFixed(2)}`) : money ? `$${r[0].toFixed(2)} … $${r[1].toFixed(2)}` : `${+r[0].toFixed(2)} … ${+r[1].toFixed(2)}`);

  const lines = [
    `# ${SPEC.version} — run ${extras.runId}`,
    '',
    `Mode: **${extras.mode}** · Spec hash \`${SPEC_HASH}\` · Data hash \`${extras.dataHash}\``,
    `Frozen endpoint (close of latest completed M1 bar used): **${iso(run.endT)}** · Study start ${SPEC.data.studyStartBeirutLocal} Asia/Beirut (${iso(run.studyStartT)}) · Warm-up from ${iso(run.warmupStartT)}`,
    `Run command: \`${extras.runCommand}\` · git ${extras.gitCommit}${extras.gitDirty ? ' (working tree had uncommitted changes)' : ''}`,
    '',
    '**No orders were placed or can be placed by this code.** Research replay only; these are fixed research assumptions, not a claim of profitability.',
    '',
    `## Mechanical conclusion (pre-declared rule): ${run.conclusion.conclusion.replace(/_/g, ' ')}`,
    '',
    run.conclusion.reason + '.',
    '',
    '## Data coverage',
    '',
    '| TF | rows | first (UTC) | last (UTC) | non-cent | OHLC viol. | non-increasing | grid misaligned | weekend bars | tz errors |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...v.map((x) => `| ${x.timeframe} | ${x.rows} | ${x.firstUtc} | ${x.lastUtc} | ${x.nonCentPrices} | ${x.ohlcViolations} | ${x.nonIncreasingTimestamps} | ${x.gridMisaligned} | ${x.weekendServerBars} | ${x.timezoneConversionErrors} |`),
    '',
    `M1 gaps (study period): ${Object.entries(run.coverage.m1Gaps.byKind).map(([k, x]) => `${k} ${x.count} (${x.missingMinutes} min)`).join(' · ')}. M5 bars substituted into unconfirmed M1 holes: ${run.coverage.substitutedM5Bars}.`,
    `Broker H4 vs M1 aggregate (study period): ${run.coverage.h4VsM1.exactMatch} exact of ${run.coverage.h4VsM1.h4BarsChecked}; ${run.coverage.h4VsM1.mismatch} mismatched (${run.coverage.h4VsM1.mismatchWithM1HoleInside} with an unconfirmed M1 hole inside); ${run.coverage.h4VsM1.noM1Inside} without M1.`,
    'Stored ticks: 0 used (no tick source attests completeness). A COMPLETED ledger row is not proof of complete coverage.',
    '',
    '## Level formation (entire replay incl. warm-up)',
    '',
    `H4 bars processed ${d.h4BarsProcessed}; pivot candidates R ${d.pivotCandidates.RESISTANCE} / S ${d.pivotCandidates.SUPPORT}; qualified (≥$10 rejection close) R ${d.qualifiedPivots.RESISTANCE} / S ${d.qualifiedPivots.SUPPORT}.`,
    `Exact-price repeat pairs, any distance: R ${d.exactPriceRepeatPairsAnyDistance.RESISTANCE} / S ${d.exactPriceRepeatPairsAnyDistance.SUPPORT}; within 5..120 bars: R ${d.exactPriceRepeatPairsInDistanceWindow.RESISTANCE} / S ${d.exactPriceRepeatPairsInDistanceWindow.SUPPORT}.`,
    `Pair outcomes: ${JSON.stringify(d.pairOutcomes)}. Activations blocked: ${JSON.stringify(d.activationsBlocked)}.`,
    `Levels activated: R ${d.levelsActivated.RESISTANCE} / S ${d.levelsActivated.SUPPORT} (${studyLevels.length} activated inside the study period, ${activeAtStudyStart} active at study start); D1-agreement tagged ${d.d1AgreementTagged}.`,
    `Level end states: ${JSON.stringify(allLevels.reduce<Record<string, number>>((a, l) => ({ ...a, [l.status]: (a[l.status] ?? 0) + 1 }), {}))}.`,
    '',
    '## Output A — event study (every qualifying first return, overlap allowed)',
    '',
    `Study-period first returns by kind: ${JSON.stringify(es.studyEventsByKind)}. Not eligible: ${JSON.stringify(es.ineligibleByReason)} (GAP_CROSS and UNOBSERVABLE are excluded from W/L and listed here separately).`,
    '',
    header,
    bucketLine('Full period', es.full),
    bucketLine('BUY (support)', es.byDirection.BUY),
    bucketLine('SELL (resistance)', es.byDirection.SELL),
    ...Object.entries(es.byYear).map(([k, b]) => bucketLine(`Year ${k}`, b)),
    ...Object.entries(es.byHalfYear).map(([k, b]) => bucketLine(k, b)),
    bucketLine('D1 agreement (descriptive)', es.withD1Agreement),
    bucketLine('No D1 agreement', es.withoutD1Agreement),
    '',
    `Dependence: ${es.dependence.distinctBeirutDaysWithEligibleEvents} distinct days with eligible events, max ${es.dependence.maxEligibleEventsOnOneDay} on one day, ${es.dependence.overlappingEligiblePairs} overlapping event pairs. ${es.dependence.note}`,
    '',
    '## Output B — one-position paper simulation (never compare with Output A totals)',
    '',
    '| Balance | Costs | Branches | Trades | W | L | Net P&L | Net exp./trade | PF | Max equity DD | Exposure % | Halted | Open at end |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...run.paper.map(({ summary: s }) => `| ${s.balanceId} | ${s.costId} | ${s.branches}${s.branchCapHit ? ' (cap hit)' : ''} | ${range(s.tradesEntered)} | ${range(s.wins)} | ${range(s.losses)} | ${range(s.netPnlUsd, true)} | ${range(s.netExpectancyUsdPerTrade, true)} | ${range(s.profitFactor)} | ${range(s.maxEquityDrawdownUsd, true)} (${range(s.maxEquityDrawdownPct)}%) | ${range(s.exposurePct)} | ${s.haltedBranches} | ${s.openAtEndBranches} |`),
    '',
    'Decision tallies (min … max across branches):',
    '',
    ...run.paper.map(({ summary: s }) => `- ${s.balanceId} × ${s.costId}: ${Object.entries(s.decisionTally).map(([k, r]) => `${k} ${range(r)}`).join(', ')}`),
    '',
    'Costs are labeled assumptions — no historical ask, spread, commission, swap or slippage evidence exists (the M1 spread column is NULL for every row). The $1,000 balance is assumed (no demo equity snapshot exists); the $10,000 run is a pre-declared sensitivity only.',
    '',
    '## Standing limitations',
    '',
    '- Previously inspected XAUUSD history is not a pristine holdout; only future watch-only observations are forward evidence.',
    '- Idealized continuous-price-path assumption inside each bar; ambiguity is reported, never resolved by choice.',
    '- Gap classification is an evidence rule (recurrence + cross-series silence), not a broker session calendar.',
    '- Per-row candle provenance columns are NULL; broker/server provenance rests on the backfill log and symbol_metadata.',
    '- Stored bar times are broker-server wall clock (EET/EEST) and are converted here; the collector itself still labels them UTC.',
  ];
  return lines.join('\n') + '\n';
}

export function writeRunArtifacts(dir: string, run: RunOutputs, extras: ManifestExtras): void {
  mkdirSync(dir, { recursive: true });
  const decisions = Object.fromEntries(run.paper.map((p) => [`${p.summary.balanceId}|${p.summary.costId}`, p.decisions]));
  const levels = Object.values(run.state.levels.levels).sort((a, b) => a.activatedT - b.activatedT || a.id.localeCompare(b.id));
  const manifest = {
    strategyVersion: SPEC.version,
    specHash: SPEC_HASH,
    specRevision: SPEC.specRevision,
    ...extras,
    frozenEndUtc: iso(run.endT),
    studyStartUtc: iso(run.studyStartT),
    warmupStartUtc: iso(run.warmupStartT),
    runtime: { node: process.versions.node, icu: process.versions.icu, tzdata: process.versions.tz },
    executionBoundary: 'NO ORDER PATH — research replay / watch-only',
    conclusion: run.conclusion,
    files: ['manifest.json', 'spec.json', 'coverage.json', 'formation.json', 'levels.json', 'levels.csv', 'pivots.csv', 'events.json', 'events.csv', 'event-study.json', 'paper-summary.json', 'paper-branches.json', 'REPORT.md'],
  };
  writeAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeAtomic(join(dir, 'spec.json'), JSON.stringify(SPEC, null, 2));
  writeAtomic(join(dir, 'coverage.json'), JSON.stringify({ ...run.coverage, provenance: extras.provenance }, null, 2));
  writeAtomic(join(dir, 'formation.json'), JSON.stringify(run.state.levels.diagnostics, null, 2));
  writeAtomic(join(dir, 'levels.json'), JSON.stringify(levels, null, 2));
  writeAtomic(join(dir, 'levels.csv'), csv(levelRows(levels)));
  writeAtomic(join(dir, 'pivots.csv'), csv(pivotRows(run.state.levels.pivotLog)));
  writeAtomic(join(dir, 'events.json'), JSON.stringify(run.events, null, 2));
  writeAtomic(join(dir, 'events.csv'), csv(eventRows(run.events, decisions)));
  writeAtomic(join(dir, 'event-study.json'), JSON.stringify(run.eventStudy, null, 2));
  writeAtomic(join(dir, 'paper-summary.json'), JSON.stringify(run.paper.map((p) => ({ summary: p.summary, decisionsByEvent: p.decisions })), null, 2));
  writeAtomic(
    join(dir, 'paper-branches.json'),
    JSON.stringify(run.paper.map((p) => ({ balanceId: p.summary.balanceId, costId: p.summary.costId, branchCapHit: p.result.branchCapHit, leaves: p.result.leaves.slice(0, 64) })), null, 2),
  );
  writeAtomic(join(dir, 'REPORT.md'), renderReport(run, extras));
}
