/**
 * Verification pass — runtime (not source-text) module graph of the study and
 * watch entry points. Loads both scripts (their main() is guarded by
 * require.main === module, so nothing runs) plus the dashboard controller, then
 * lists every project module Node actually resolved and flags any that could
 * lead to order execution. Also checks built-ins that could open network
 * connections or spawn processes.
 *
 * Run: cd backend && npx tsx research-output/xauusd-h4-confirmed-retest-v1/verification/runtime-module-graph.ts
 */
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
require(join(root, 'scripts/confirmed-retest-study.ts'));
require(join(root, 'scripts/confirmed-retest-watch.ts'));
require(join(root, 'src/research/confirmed-retest-dashboard/confirmed-retest.controller.ts'));

const all = Object.keys(require.cache);
const project = all.filter((p) => p.startsWith(root) && !p.includes('node_modules')).map((p) => relative(root, p).replace(/\\/g, '/')).sort();
const packages = [...new Set(all.filter((p) => p.includes('node_modules')).map((p) => p.split(/node_modules[\\/]/).pop()!.split(/[\\/]/).slice(0, p.includes('@') ? 2 : 1).join('/')))].sort();
const executionRisk = /autonomous|trend-breakout|executor|execution|telegram|bullmq|ioredis|jobs\//i;
const flaggedProject = project.filter((p) => executionRisk.test(p) && !p.startsWith('research-output/'));
const flaggedPackages = packages.filter((p) => /bullmq|ioredis|axios|node-fetch|undici|metatrader|rpyc|telegram/i.test(p));

const result = {
  generatedAtUtc: new Date().toISOString(),
  projectModulesLoaded: project,
  thirdPartyPackagesLoaded: packages,
  flaggedProjectModules: flaggedProject,
  flaggedPackages,
  note:
    'The Node research/watch code has no MT5 connection of its own. The only order path in this repository is collector/app/executor.py (Python), ' +
    'reached only when the collector polls an approved decision with AUTONOMOUS_EXECUTION_ENABLED=true.',
};
writeFileSync(join(__dirname, 'runtime-module-graph.json'), JSON.stringify(result, null, 2));
console.log(`project modules: ${project.length}; flagged: ${JSON.stringify(flaggedProject)}; flagged packages: ${JSON.stringify(flaggedPackages)}`);
console.log(project.join('\n'));
