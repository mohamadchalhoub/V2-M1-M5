import { Controller, Get, Injectable, Module, UseGuards } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuthModule } from '../../auth/auth.module';
import { DashboardTokenGuard } from '../../auth/dashboard-token.guard';
import { eventRows, levelRows } from '../confirmed-retest/report';
import { SPEC, SPEC_HASH } from '../confirmed-retest/spec';
import type { FirstReturnEvent, Level } from '../confirmed-retest/types';

/**
 * Dashboard read side for `xauusd-h4-confirmed-retest-v1`: serves the files
 * written by `npm run confirmed-retest:study` (research-output/) and the
 * watch-only runner (research-state/). File reads only — no database, no
 * scheduler, no order path. Not account-scoped: the study uses broker
 * market data, not an account's trades.
 */
@Injectable()
export class ConfirmedRetestReadService {
  private readonly outputRoot = resolve(process.env.RESEARCH_OUTPUT_DIR ?? join(process.cwd(), 'research-output'), SPEC.version);
  private readonly stateRoot = resolve(process.env.RESEARCH_STATE_DIR ?? join(process.cwd(), 'research-state'), SPEC.version);

  private readJson<T>(path: string): T | null {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
  }

  summary() {
    const latest = this.readJson<{ runId: string; dir: string; frozenEndUtc: string; specHash: string }>(join(this.outputRoot, 'latest.json'));
    const watch = this.readJson<Record<string, unknown>>(join(this.stateRoot, 'latest-watch.json'));
    const base = { strategyVersion: SPEC.version, currentSpecHash: SPEC_HASH, executionBoundary: 'NO ORDER PATH — research replay and watch-only', watch };
    if (!latest) return { ...base, run: null };
    const dir = join(this.outputRoot, 'runs', latest.runId);
    const manifest = this.readJson<Record<string, unknown>>(join(dir, 'manifest.json'));
    const coverage = this.readJson<Record<string, unknown>>(join(dir, 'coverage.json'));
    const paper = this.readJson<Array<{ summary: Record<string, unknown>; decisionsByEvent: Record<string, Record<string, number>> }>>(join(dir, 'paper-summary.json')) ?? [];
    const events = this.readJson<FirstReturnEvent[]>(join(dir, 'events.json')) ?? [];
    const levels = this.readJson<Level[]>(join(dir, 'levels.json')) ?? [];
    const decisions = Object.fromEntries(paper.map((p) => [`${p.summary.balanceId}|${p.summary.costId}`, p.decisionsByEvent]));
    return {
      ...base,
      run: {
        runId: latest.runId,
        specHashMatchesCurrent: latest.specHash === SPEC_HASH,
        manifest,
        eventStudy: this.readJson(join(dir, 'event-study.json')),
        formation: this.readJson(join(dir, 'formation.json')),
        coverage: coverage && {
          validations: coverage.validations,
          m1Gaps: coverage.m1Gaps,
          warmupGaps: coverage.warmupGaps,
          substitutedM5Bars: coverage.substitutedM5Bars,
          h4VsM1: coverage.h4VsM1,
          provenance: coverage.provenance,
        },
        paper,
        levels: levelRows(levels),
        events: eventRows(events, decisions),
      },
    };
  }
}

@Controller('research/xauusd-confirmed-retest')
@UseGuards(DashboardTokenGuard)
export class ConfirmedRetestController {
  constructor(private readonly reader: ConfirmedRetestReadService) {}

  @Get()
  getSummary() {
    return this.reader.summary();
  }
}

@Module({
  imports: [AuthModule],
  controllers: [ConfirmedRetestController],
  providers: [ConfirmedRetestReadService],
})
export class ConfirmedRetestDashboardModule {}
