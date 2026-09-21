// Runs inside each spec file's own process, before that file's tests run.
// Vitest's globalSetup runs in a separate process whose env changes do NOT
// propagate to test workers — this file is what actually makes
// DATABASE_URL point at the disposable test database for the code under test.
import { config } from 'dotenv';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env.test'), override: true });

// isKillSwitchActive() defaults to `<cwd>/KILL_SWITCH` when this env var is unset — which, run
// from `backend/`, is the SAME path an operator's real kill switch lives at. Without this, a
// test run happening to coincide with a genuinely engaged operational kill switch would see
// every kill-switch-gated check as active, and (worse) a test run that leaves it engaged would
// never be distinguishable from a real one. Point every test worker at its own throwaway path by
// default; a test that specifically exercises kill-switch behavior overrides this further in its
// own beforeEach (see test/autonomous/kill-switch.spec.ts).
process.env.AUTONOMOUS_KILL_SWITCH_PATH = join(mkdtempSync(join(tmpdir(), 'test-kill-switch-')), 'KILL_SWITCH');

// `AppModule`'s `ConfigModule.forRoot({ isGlobal: true })` loads the REAL `backend/.env` (not
// `.env.test`) the first time it runs inside a test file (via `createTestApp()`), using dotenv's
// default `override: false` — so it only fills in keys not already set, but for any key `.env.test`
// above didn't define, whatever this repo's own real `.env` currently has for it silently becomes
// this test process's value. `GOLD_EXECUTION_MODE` is a real example: this deployment's `.env` was
// set to `DEMO` once gold DEMO was activated operationally, which then leaked into a test
// asserting the OFF default. Setting it explicitly here (running BEFORE ConfigModule ever loads
// `.env`) means ConfigModule's later, non-destructive load leaves it alone — tests get a
// deterministic default regardless of this repo's own current operational `.env` state.
process.env.GOLD_EXECUTION_MODE = 'OFF';

// Same reasoning as AUTONOMOUS_KILL_SWITCH_PATH above, extended to every
// gold file-based runtime path (`gold-execution-runtime/{ai-summaries,settings}.json`
// and `GOLD_KILL_SWITCH`) — all three default to a path under `process.cwd()`
// when their env var is unset (see gold-ai-summary.service.ts,
// gold-runtime-settings.service.ts, gold-kill-switch.ts), which from `backend/`
// IS the real operator-facing gold-execution-runtime directory. Without this,
// any test that exercises the fill/protection-monitor/execution pipeline (even
// indirectly, via a real HTTP request through AppModule) silently appends
// synthetic FILL_CONFIRMED/MISSING_PROTECTION narration into the SAME
// ai-summaries.json a live demo dashboard reads — this happened for real on
// 2026-09-15 (ticket=999/2650.3 fixture fills from gold-execution-e2e.spec.ts,
// plus 771xxx/888xxx MISSING_PROTECTION entries from manual verification, both
// landing in the real runtime file because this isolation didn't exist yet).
// Point every test worker at its own throwaway temp directory by default.
const isolatedGoldRuntimeDir = mkdtempSync(join(tmpdir(), 'test-gold-runtime-'));
process.env.GOLD_AI_SUMMARIES_PATH = join(isolatedGoldRuntimeDir, 'ai-summaries.json');
process.env.GOLD_RUNTIME_SETTINGS_PATH = join(isolatedGoldRuntimeDir, 'settings.json');
process.env.GOLD_KILL_SWITCH_PATH = join(isolatedGoldRuntimeDir, 'GOLD_KILL_SWITCH');

// Same isolation, extended to the active strategy
// (`xauusd-m1-rsi-retest-extremes-v1`). Every one of these paths defaults to a
// location under `process.cwd()`, which from `backend/` is the REAL
// operator-facing runtime directory — so without this a test could engage the
// live stop-new-entries switch, overwrite the live volume setting, or read the
// live watch state and report a test fixture as current health.
//
// The two GOLD_* paths below matter for this strategy specifically: it
// deliberately honours the pre-existing gold controls as well as its own
// (see xauusd-rsi/controls.ts), so leaving them pointed at the repository
// would make every test in this suite see the real `backend/GOLD_KILL_SWITCH`
// file — which is currently PRESENT as a deliberate operational pause — and
// every entry would be refused for reasons unrelated to the case under test.
const isolatedRsiRuntimeDir = mkdtempSync(join(tmpdir(), 'test-xauusd-rsi-runtime-'));
process.env.XAUUSD_RSI_STATE_DIR = isolatedRsiRuntimeDir;
process.env.XAUUSD_RSI_RUNTIME_SETTINGS_PATH = join(isolatedRsiRuntimeDir, 'settings.json');
process.env.XAUUSD_RSI_KILL_SWITCH_PATH = join(isolatedRsiRuntimeDir, 'XAUUSD_RSI_KILL_SWITCH');
process.env.XAUUSD_RSI_STOP_NEW_ENTRIES_PATH = join(isolatedRsiRuntimeDir, 'XAUUSD_RSI_STOP_NEW_ENTRIES');
process.env.GOLD_STOP_NEW_ENTRIES_PATH = join(isolatedGoldRuntimeDir, 'GOLD_STOP_NEW_ENTRIES');
// Fails closed in tests exactly as it does in production: a test that needs
// DEMO submission opts in explicitly rather than inheriting an active mode.
process.env.XAUUSD_RSI_EXECUTION_MODE = 'OFF';
delete process.env.XAUUSD_RSI_STOP_NEW_ENTRIES;
delete process.env.GOLD_STOP_NEW_ENTRIES;
