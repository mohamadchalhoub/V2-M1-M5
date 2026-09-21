// The dashboard endpoint serves exactly the committed run artifacts (file reads only).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmedRetestReadService } from '../../../src/research/confirmed-retest-dashboard/confirmed-retest.controller';
import { SPEC, SPEC_HASH } from '../../../src/research/confirmed-retest/spec';

const saved = { out: process.env.RESEARCH_OUTPUT_DIR, state: process.env.RESEARCH_STATE_DIR };
afterEach(() => {
  process.env.RESEARCH_OUTPUT_DIR = saved.out;
  process.env.RESEARCH_STATE_DIR = saved.state;
});

describe('ConfirmedRetestReadService', () => {
  it('returns run: null (never an error or fabricated numbers) when no study has been run', () => {
    process.env.RESEARCH_OUTPUT_DIR = mkdtempSync(join(tmpdir(), 'crt-out-'));
    process.env.RESEARCH_STATE_DIR = mkdtempSync(join(tmpdir(), 'crt-state-'));
    expect(new ConfirmedRetestReadService().summary()).toMatchObject({ currentSpecHash: SPEC_HASH, run: null, watch: null });
  });

  it('serves the latest run named by latest.json and flags a spec-hash mismatch', () => {
    const out = mkdtempSync(join(tmpdir(), 'crt-out-'));
    const runDir = join(out, SPEC.version, 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(out, SPEC.version, 'latest.json'), JSON.stringify({ runId: 'r1', dir: 'x', frozenEndUtc: 'x', specHash: 'older' }));
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ conclusion: { conclusion: 'INSUFFICIENT_EVIDENCE' } }));
    process.env.RESEARCH_OUTPUT_DIR = out;
    process.env.RESEARCH_STATE_DIR = mkdtempSync(join(tmpdir(), 'crt-state-'));
    const summary = new ConfirmedRetestReadService().summary();
    expect(summary.run).toMatchObject({ runId: 'r1', specHashMatchesCurrent: false, events: [], levels: [], paper: [] });
  });

  it('reads the committed historical run in research-output/', () => {
    process.env.RESEARCH_OUTPUT_DIR = resolve(__dirname, '../../../research-output');
    process.env.RESEARCH_STATE_DIR = mkdtempSync(join(tmpdir(), 'crt-state-'));
    const summary = new ConfirmedRetestReadService().summary();
    expect(summary.run?.specHashMatchesCurrent).toBe(true);
    expect(summary.run?.paper).toHaveLength(SPEC.paper.startingBalances.length * SPEC.costScenarios.length);
  });
});
