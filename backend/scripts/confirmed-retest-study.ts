/**
 * scripts/confirmed-retest-study.ts — historical replay for
 * `xauusd-h4-confirmed-retest-v1` (spec: src/research/confirmed-retest/).
 *
 * READ-ONLY against the database; no MT5, no network, no orders. Freezes the
 * endpoint (default: close of the latest stored XAUUSD M1 bar), writes a
 * self-describing run directory and updates `latest.json`.
 *
 * Run:  npm run confirmed-retest:study [-- --end 2026-09-11T20:00:00Z] [-- --out <dir>]
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { latestCompletedM1CloseUtc } from '../src/research/confirmed-retest/data-source';
import { executeRun, loadAll } from '../src/research/confirmed-retest/pipeline';
import { writeRunArtifacts } from '../src/research/confirmed-retest/report';
import { SPEC, SPEC_HASH } from '../src/research/confirmed-retest/spec';

export const OUTPUT_ROOT = resolve(__dirname, '..', 'research-output', SPEC.version);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const latest = await latestCompletedM1CloseUtc(prisma, SPEC.symbol);
    if (latest === null) throw new Error('no stored XAUUSD M1 data');
    const requested = arg('end') ? Date.parse(arg('end') as string) : latest;
    if (Number.isNaN(requested)) throw new Error(`invalid --end ${arg('end')}`);
    const endT = Math.min(requested, latest);
    const runId = `end-${new Date(endT).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z')}__spec-${SPEC_HASH.slice(0, 12)}`;
    const outDir = arg('out') ? resolve(arg('out') as string) : join(OUTPUT_ROOT, 'runs', runId);

    console.log(`[${SPEC.version}] spec ${SPEC_HASH}`);
    console.log(`frozen endpoint ${new Date(endT).toISOString()} (latest stored M1 close ${new Date(latest).toISOString()})`);
    const t0 = Date.now();
    const loaded = await loadAll(prisma, endT);
    console.log(`loaded ${loaded.validations.map((v) => `${v.timeframe}=${v.rows}`).join(' ')} in ${((Date.now() - t0) / 1000).toFixed(1)}s; data hash ${loaded.dataHash}`);
    const run = executeRun(loaded);
    console.log(`replayed ${run.state.counters.evalBarsProcessed} evaluation bars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const runCommand = `npm run confirmed-retest:study -- --end ${new Date(endT).toISOString()}`;
    writeRunArtifacts(outDir, run, {
      runId,
      runCommand,
      generatedAtUtc: new Date().toISOString(),
      gitCommit: git('rev-parse HEAD'),
      gitDirty: git('status --porcelain -- src/research/confirmed-retest scripts') !== '',
      dataHash: loaded.dataHash,
      provenance: loaded.provenance,
      mode: 'HISTORICAL_STUDY',
    });
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    writeFileSync(join(OUTPUT_ROOT, 'latest.json'), JSON.stringify({ runId, dir: outDir.replace(resolve(__dirname, '..') + '\\', '').replace(/\\/g, '/'), frozenEndUtc: new Date(endT).toISOString(), specHash: SPEC_HASH }, null, 2));
    console.log(`conclusion: ${run.conclusion.conclusion} — ${run.conclusion.reason}`);
    console.log(`artifacts: ${outDir}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
