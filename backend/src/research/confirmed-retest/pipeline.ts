/**
 * research/confirmed-retest/pipeline — composes the pure pieces into one
 * run: load (read-only) → validate → classify gaps → evaluation stream →
 * replay → paper simulations → statistics. Shared by the historical study
 * script and the watch-only runner so both apply identical rules.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { dailyBreakNewYorkTimes, gapInventory, h4VsM1Consistency, type GapInventory, type H4ConsistencyReport } from './audit';
import { DURATION_MS, loadProvenance, loadSeries, type ProvenanceReport, type SeriesValidation } from './data-source';
import { buildEvaluationStream, type SeriesMap, type StreamBuildResult } from './gaps';
import { runPaperSimulation, type BalanceScenario, type CostScenario, type PaperResult } from './paper';
import { advance, createReplayState, type ReplayState } from './replay';
import { SPEC, SPEC_HASH } from './spec';
import { classifyConclusion, eventDecisionMatrix, summarizeEventStudy, summarizePaper, type EventStudySummary, type PaperSummary } from './statistics';
import type { Bar, FirstReturnEvent, Timeframe } from './types';

export const LOADED_TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

export interface LoadedData {
  symbol: string;
  endT: number;
  series: SeriesMap;
  validations: SeriesValidation[];
  dataHash: string;
  provenance: ProvenanceReport;
}

export async function loadAll(prisma: PrismaClient, endT: number): Promise<LoadedData> {
  const hash = createHash('sha256');
  const series: SeriesMap = {};
  const validations: SeriesValidation[] = [];
  for (const tf of LOADED_TIMEFRAMES) {
    const { bars, validation } = await loadSeries(prisma, SPEC.symbol, tf, endT, hash);
    series[tf] = bars;
    validations.push(validation);
  }
  const provenance = await loadProvenance(prisma, SPEC.symbol);
  return { symbol: SPEC.symbol, endT, series, validations, dataHash: hash.digest('hex'), provenance };
}

export interface RunOutputs {
  specHash: string;
  studyStartT: number;
  warmupStartT: number;
  endT: number;
  build: StreamBuildResult;
  state: ReplayState;
  events: FirstReturnEvent[];
  eventStudy: EventStudySummary;
  paper: Array<{ result: PaperResult; summary: PaperSummary; decisions: Record<string, Record<string, number>> }>;
  conclusion: ReturnType<typeof classifyConclusion>;
  coverage: {
    validations: SeriesValidation[];
    m1Gaps: GapInventory;
    warmupGaps: GapInventory;
    substitutedM5Bars: number;
    h4VsM1: H4ConsistencyReport;
    dailyBreakNewYorkStartTimes: Record<string, Record<string, number>>;
    recurrenceEvidencePool: number;
  };
}

export interface RunOptions {
  /** Resume from existing replay state (watch-only). */
  state?: ReplayState;
  observedAtT?: number | null;
}

export function executeRun(loaded: LoadedData, opts: RunOptions = {}): RunOutputs {
  const studyStartT = Date.parse(SPEC.data.studyStartUtc);
  const h4 = loaded.series.H4 ?? [];
  const d1 = loaded.series.D1 ?? [];
  if (!h4.length) throw new Error('no H4 data loaded');
  const warmupStartT = h4[0].t;
  const build = buildEvaluationStream({ series: loaded.series, warmupStartT, studyStartT, endT: loaded.endT });

  const state = opts.state ?? createReplayState(studyStartT);
  const stripSeries = (bars: Bar[]) => bars.map(({ t, dur, o, h, l, c }) => ({ t, dur, o, h, l, c }));
  advance(state, { h4: stripSeries(h4), d1: stripSeries(d1), stream: build.stream }, { endT: loaded.endT, observedAtT: opts.observedAtT ?? null });

  const events = state.eventOrder.map((id) => state.events[id]);
  const eventStudy = summarizeEventStudy(events, loaded.endT);
  const studyStream = build.stream.filter((b) => b.t >= studyStartT);

  const paper = SPEC.paper.startingBalances.flatMap((balance) =>
    SPEC.costScenarios.map((cost) => {
      const result = runPaperSimulation({ events, studyStream, studyStartT, endT: loaded.endT, balance: balance as BalanceScenario, cost: cost as CostScenario });
      return { result, summary: summarizePaper(result), decisions: eventDecisionMatrix(result) };
    }),
  );
  const sensitivityBase = paper.find((p) => p.summary.balanceId === 'ASSUMED_10000_SENSITIVITY' && p.summary.costId === 'ASSUMED_BASE')?.summary ?? null;
  const conclusion = classifyConclusion(eventStudy.full, sensitivityBase);

  const m1 = loaded.series.M1 ?? [];
  return {
    specHash: SPEC_HASH,
    studyStartT,
    warmupStartT,
    endT: loaded.endT,
    build,
    state,
    events,
    eventStudy,
    paper,
    conclusion,
    coverage: {
      validations: loaded.validations,
      m1Gaps: gapInventory(build.m1Gaps),
      warmupGaps: gapInventory(build.warmupGaps),
      substitutedM5Bars: build.substitutedM5Count,
      h4VsM1: h4VsM1Consistency(h4, m1, studyStartT, loaded.endT, build.m1Gaps),
      dailyBreakNewYorkStartTimes: dailyBreakNewYorkTimes(build.m1Gaps),
      recurrenceEvidencePool: build.evidence.reopens.length,
    },
  };
}

export { DURATION_MS };
