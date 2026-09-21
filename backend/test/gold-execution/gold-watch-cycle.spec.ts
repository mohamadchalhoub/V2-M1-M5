/**
 * Integration-level proof of the friend's rule as corrected: an M1-replay-
 * discovered touch must ONLY consume the opportunity and leave an audit
 * trail — it must NEVER queue a real order, no matter how it was found
 * (a normal cycle, a startup backlog after downtime, or a brief
 * touch-and-reversal the live-quote layer's latest-tick sampling missed but
 * M1's own wick-based close detection later caught). `confirmed-retest-v2`'s
 * `loadAll`/`executeRun` are mocked here specifically so this test can
 * assert the exact behavior in question (event -> audit log, never
 * coordinator.evaluate) without needing to construct real H4/D1 pivot data
 * — `test/research/confirmed-retest-v2/*` already covers the formation
 * engine itself in full; this test is about what `runGoldWatchCycle` DOES
 * with an event once v2 hands one back, not about producing one correctly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { GoldExecutionCoordinatorService } from '../../src/gold-execution/gold-execution-coordinator.service';
import { GoldRuntimeSettingsService } from '../../src/gold-execution/gold-runtime-settings.service';
import { consumeLevel, createLevelEngineState } from '../../src/research/confirmed-retest-v2/levels';
import type { FirstReturnEvent } from '../../src/research/confirmed-retest-v2/types';
import { SPEC_HASH } from '../../src/research/confirmed-retest-v2/spec';

const loadAllMock = vi.fn();
const executeRunMock = vi.fn();
vi.mock('../../src/research/confirmed-retest-v2/pipeline', () => ({
  loadAll: (...args: unknown[]) => loadAllMock(...args),
  executeRun: (...args: unknown[]) => executeRunMock(...args),
}));

// Imported AFTER the mock is registered (vitest hoists vi.mock calls, but the dynamic import
// below keeps this explicit and avoids any ordering ambiguity).
async function loadSubject() {
  return import('../../src/gold-execution/gold-signal-source');
}

function makeEvent(overrides: Partial<FirstReturnEvent> = {}): FirstReturnEvent {
  return {
    id: 'evt:lvl:S:265000:g1',
    levelId: 'lvl:S:265000:g1',
    role: 'SUPPORT',
    levelPrice: 265000,
    generation: 1,
    kind: 'ORDINARY',
    period: 'STUDY',
    touchStartT: 1_000_000,
    touchEndT: 1_060_000,
    touchResolution: 'M1',
    beirut: { date: '2026-09-15', year: 2026, half: '2026-H2', hour: 9, minute: 0 },
    inWindow: true,
    direction: 'BUY',
    eligible: true,
    ineligibleReason: null,
    gapId: null,
    selection: null,
    d1Agreement: false,
    levelActivatedT: 500_000,
    outcome: null,
    observedAtT: null, // set fresh at cycle time by the mock below, matching real executeRun's own behavior
    ...overrides,
  };
}

describe('runGoldWatchCycle — M1-discovered touches are audit-only, never submitted', () => {
  let prisma: PrismaClient;
  let coordinator: GoldExecutionCoordinatorService;
  let stateDir: string;

  beforeAll(() => {
    prisma = new PrismaClient();
    coordinator = new GoldExecutionCoordinatorService(prisma as any, new GoldRuntimeSettingsService());
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    stateDir = mkdtempSync(join(tmpdir(), 'gold-watch-cycle-test-'));
    loadAllMock.mockReset();
    executeRunMock.mockReset();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function mockRun(events: FirstReturnEvent[]) {
    loadAllMock.mockResolvedValue({ endT: 2_000_000 });
    executeRunMock.mockImplementation((_loaded: unknown, opts: { observedAtT?: number | null }) => ({
      state: { specHash: SPEC_HASH, studyStartT: 0, levels: createLevelEngineState(), lastEvalBar: null, events: {}, eventOrder: [], pendingRaceEventIds: [], clockT: 2_000_000, counters: { evalBarsProcessed: 0, evalBarsByResolution: {}, selectionBothSidesTouched: 0 } },
      events: events.map((e) => ({ ...e, observedAtT: opts.observedAtT ?? null })),
    }));
  }

  it('does not call the coordinator for a normal-cycle M1-discovered touch — logs audit-only and consumes it', async () => {
    const { account } = await setupAccountWithToken(prisma);
    mockRun([makeEvent()]);
    const evaluateSpy = vi.spyOn(coordinator, 'evaluate');
    const { GoldWatchStore, runGoldWatchCycle } = await loadSubject();
    const store = new GoldWatchStore(stateDir);

    const result = await runGoldWatchCycle({
      prisma, coordinator, store, nowT: 2_000_000, accountId: account.id,
      buildContext: async () => { throw new Error('buildContext must never be called for an M1-discovered event'); },
      getExecutablePrice: async () => { throw new Error('getExecutablePrice must never be called for an M1-discovered event'); },
      getLiveQuote: async () => null,
    });

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(result.actionableEvents).toHaveLength(1);
    expect(result.auditOnlyDecisionIds).toHaveLength(1);

    const row = await prisma.autonomousDecision.findUniqueOrThrow({ where: { id: result.auditOnlyDecisionIds[0] } });
    expect(row.orderStatus).toBe('NONE');
    expect(row.riskManagerApproved).toBe(false);
    expect(row.symbol).toBe('XAUUSD');

    // Consumed: a second cycle over the SAME event must not re-log or re-act on it.
    const store2 = new GoldWatchStore(stateDir);
    const secondResult = await runGoldWatchCycle({
      prisma, coordinator, store: store2, nowT: 2_060_000, accountId: account.id,
      buildContext: async () => { throw new Error('must never be called'); },
      getExecutablePrice: async () => { throw new Error('must never be called'); },
      getLiveQuote: async () => null,
    });
    expect(secondResult.actionableEvents).toHaveLength(0);
  });

  it('startup backlog: an M1-discovered touch found only after a long gap (collector/candle-sync stall) is still never submitted, only logged and consumed', async () => {
    const { account } = await setupAccountWithToken(prisma);
    // The touch's own bar closed 90 minutes before this cycle even runs — a realistic stall
    // backlog scenario (see DEMO_HANDOFF.md's own 83-minute-staleness finding).
    const staleTouchEndT = 2_000_000 - 90 * 60_000;
    mockRun([makeEvent({ touchEndT: staleTouchEndT, touchStartT: staleTouchEndT - 60_000 })]);
    const evaluateSpy = vi.spyOn(coordinator, 'evaluate');
    const { GoldWatchStore, runGoldWatchCycle } = await loadSubject();
    const store = new GoldWatchStore(stateDir);

    const result = await runGoldWatchCycle({
      prisma, coordinator, store, nowT: 2_000_000, accountId: account.id,
      buildContext: async () => { throw new Error('must never be called'); },
      getExecutablePrice: async () => { throw new Error('must never be called'); },
      getLiveQuote: async () => null,
    });

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(result.auditOnlyDecisionIds).toHaveLength(1);
    const row = await prisma.autonomousDecision.findUniqueOrThrow({ where: { id: result.auditOnlyDecisionIds[0] } });
    expect(row.orderStatus).toBe('NONE');
  });

  it('a touch M1 only catches via its real wick (a brief touch-and-reversal the live-quote layer missed between polls) is still never submitted, only logged and consumed', async () => {
    // Simulates the exact scenario named in gold-live-touch.spec.ts's own reversal test: the
    // live layer's latest-tick sampling saw price on the same side both times it polled and
    // never flagged a touch, but the underlying M1 candle's real high/low shows the wick DID
    // reach the level and reverse within that minute. Once M1 replay catches up and discovers
    // that touch, it must be treated exactly like any other M1-discovered event: audit-only.
    const { account } = await setupAccountWithToken(prisma);
    mockRun([makeEvent({ id: 'evt:reversal', kind: 'ORDINARY' })]);
    const evaluateSpy = vi.spyOn(coordinator, 'evaluate');
    const { GoldWatchStore, runGoldWatchCycle } = await loadSubject();
    const store = new GoldWatchStore(stateDir);

    const result = await runGoldWatchCycle({
      prisma, coordinator, store, nowT: 2_000_000, accountId: account.id,
      buildContext: async () => { throw new Error('must never be called'); },
      getExecutablePrice: async () => { throw new Error('must never be called'); },
      getLiveQuote: async () => null,
    });

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(result.auditOnlyDecisionIds).toHaveLength(1);
  });
});

describe('runGoldWatchCycle — M1 and live-quote layers share ONE persistent state correctly', () => {
  let prisma: PrismaClient;
  let coordinator: GoldExecutionCoordinatorService;
  let stateDir: string;

  beforeAll(() => {
    prisma = new PrismaClient();
    coordinator = new GoldExecutionCoordinatorService(prisma as any, new GoldRuntimeSettingsService());
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    stateDir = mkdtempSync(join(tmpdir(), 'gold-watch-cycle-shared-state-test-'));
    loadAllMock.mockReset();
    executeRunMock.mockReset();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('a level M1 already consumed this cycle is correctly excluded from live detection (no stale order); an untouched sibling level remains fully live-detectable in the SAME cycle (no suppression)', async () => {
    const { account } = await setupAccountWithToken(prisma);
    // 2026-09-15T08:00:00Z = 11:00 Asia/Beirut — inside the 04:00-12:00 window (with headroom
    // for the second cycle 60s later to stay inside it too).
    const nowT = Date.parse('2026-09-15T08:00:00.000Z');

    // Two DISTINCT active levels going into this cycle. Level A's first-return event is already
    // visible in the M1 stream this cycle (M1 replay will consume it via the real, unchanged
    // consumeLevel()). Level B has no M1-visible touch yet — it must remain fully active and
    // available to the live-quote layer within this SAME cycle.
    const levelEngineState = createLevelEngineState();
    const activatedT = nowT - 3 * 60 * 60_000;
    const addLevel = (id: string, role: 'SUPPORT' | 'RESISTANCE', price: number) => {
      const key = `${role}|${price}`;
      levelEngineState.levels[id] = {
        id, key, role, price, generation: 1, pivotId: 'p', pivotIndex: 1, pivotT: activatedT - 60_000,
        retestId: 'r', retestIndex: 2, retestT: activatedT - 30_000, confirmationH4Index: 3,
        confirmationT: activatedT, activationH4Index: 3, activatedT, d1Agreement: false,
        d1AgreementPivotT: null, status: 'ACTIVE', statusT: null, barsSinceActivation: 0,
        firstReturnEventId: null, laterBreakT: null,
      };
      levelEngineState.activeLevelIds.push(id);
      levelEngineState.keys[key] = { key, role, price, phase: 'ACTIVE', generation: 1, levelId: id, breakH4Index: null, breakT: null, retiredT: null };
    };
    addLevel('lvl:A', 'SUPPORT', 265000); // $2650.00
    addLevel('lvl:B', 'SUPPORT', 260000); // $2600.00 — untouched by M1 this cycle

    loadAllMock.mockResolvedValue({ endT: nowT });
    executeRunMock.mockImplementation((_loaded: unknown, opts: { observedAtT?: number | null }) => {
      // Mimic what the real M1 replay path does: consume level A via the exact same public
      // consumeLevel() function, and hand back its FirstReturnEvent — level B is left untouched.
      const eventA = makeEvent({ id: 'evt:A', levelId: 'lvl:A', levelPrice: 265000, observedAtT: opts.observedAtT ?? null });
      consumeLevel(levelEngineState, 'lvl:A', nowT - 5 * 60_000, eventA.id);
      return {
        state: { specHash: SPEC_HASH, studyStartT: 0, levels: levelEngineState, lastEvalBar: null, events: {}, eventOrder: [], pendingRaceEventIds: [], clockT: nowT, counters: { evalBarsProcessed: 0, evalBarsByResolution: {}, selectionBothSidesTouched: 0 } },
        events: [eventA],
      };
    });

    const evaluateSpy = vi.spyOn(coordinator, 'evaluate').mockResolvedValue({
      mode: 'DEMO', stopNewEntriesActive: false, verdict: { approved: true, rejectionReason: null, volumeLots: 0.01 }, queuedDecisionId: 'fake-decision-id',
    });
    const { GoldWatchStore, runGoldWatchCycle } = await loadSubject();
    const store = new GoldWatchStore(stateDir);

    const result = await runGoldWatchCycle({
      prisma, coordinator, store, nowT, accountId: account.id,
      buildContext: async () => ({
        accountInfo: {} as any, occupancy: { hasExistingXauusdExposure: false, exposureDescription: null },
        volumeConstraints: { minLots: 0.01, maxLots: 100, stepLots: 0.01 }, maxEntryDeviationPoints: 200, goldPointSize: 0.01,
      }),
      getExecutablePrice: async (direction) => (direction === 'BUY' ? 2599.9 : 2599.7),
      // Level B (SUPPORT @ $2600.00) is touched live THIS cycle — B never appeared in the M1
      // events array above, so this is the live layer's own, independent discovery.
      getLiveQuote: async () => ({ bid: 2599.9, atT: nowT }),
    });

    // Level A: M1 discovered and consumed it — audit-only, never submitted, never handed to the
    // live layer at all (it was already gone from activeLevelIds by the time detectLiveTouches ran).
    expect(result.actionableEvents.map((e) => e.id)).toEqual(['evt:A']);
    expect(result.auditOnlyDecisionIds).toHaveLength(1);
    const auditRow = await prisma.autonomousDecision.findUniqueOrThrow({ where: { id: result.auditOnlyDecisionIds[0] } });
    expect(auditRow.orderStatus).toBe('NONE'); // never a stale order from the M1-side consumption

    // Level B: untouched by M1, first observed live THIS cycle. First observation only
    // establishes a baseline (see gold-live-touch.ts) — not itself a touch — so it correctly
    // produces NO event yet on this very first live poll. That is not suppression: it is the
    // same "no prior reference point" rule every level starts with, live-side, and B remains
    // fully active for the very next poll.
    expect(result.liveTouchEvents).toHaveLength(0);
    expect(levelEngineState.activeLevelIds).toContain('lvl:B');
    expect(evaluateSpy).not.toHaveBeenCalled(); // neither path queued anything this cycle

    // Next cycle: level B is now touched live — proves it was never suppressed by level A's
    // same-cycle M1 consumption, and that persisted live-touch state correctly carries the
    // baseline across cycles/state saves.
    loadAllMock.mockResolvedValue({ endT: nowT + 60_000 });
    executeRunMock.mockImplementation((_loaded: unknown) => ({
      state: { specHash: SPEC_HASH, studyStartT: 0, levels: levelEngineState, lastEvalBar: null, events: {}, eventOrder: [], pendingRaceEventIds: [], clockT: nowT + 60_000, counters: { evalBarsProcessed: 0, evalBarsByResolution: {}, selectionBothSidesTouched: 0 } },
      events: [],
    }));
    const store2 = new GoldWatchStore(stateDir);
    const secondResult = await runGoldWatchCycle({
      prisma, coordinator, store: store2, nowT: nowT + 60_000, accountId: account.id,
      buildContext: async () => ({
        accountInfo: {} as any, occupancy: { hasExistingXauusdExposure: false, exposureDescription: null },
        volumeConstraints: { minLots: 0.01, maxLots: 100, stepLots: 0.01 }, maxEntryDeviationPoints: 200, goldPointSize: 0.01,
      }),
      getExecutablePrice: async (direction) => (direction === 'BUY' ? 2599.5 : 2599.3),
      getLiveQuote: async () => ({ bid: 2599.5, atT: nowT + 60_000 }), // now genuinely crossed $2600 SUPPORT
    });

    expect(secondResult.liveTouchEvents).toHaveLength(1);
    expect(secondResult.liveTouchEvents[0].levelId).toBe('lvl:B');
    expect(evaluateSpy).toHaveBeenCalledTimes(1); // the ONLY coordinator call across both cycles — live layer, level B, second cycle
  });
});
