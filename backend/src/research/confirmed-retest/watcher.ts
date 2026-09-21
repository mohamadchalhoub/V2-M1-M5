/**
 * research/confirmed-retest/watcher — one restart-safe watch-only cycle for
 * `xauusd-h4-confirmed-retest-v1`, with every data source injected so the
 * cycle is testable without a database or terminal.
 *
 * Guarantees, each enforced here rather than by convention:
 * - Only newly SETTLED completed bars are processed; the replay cursor lives in
 *   persisted state, so a restart continues exactly where it stopped and never
 *   resets level eligibility (there is no per-day or per-start reset path).
 * - State is saved atomically BEFORE journaling; the journal is reconciled from
 *   state with idempotency keys, so a crash between the two is repaired on the
 *   next cycle without duplicates.
 * - Session-dependent evaluation is BLOCKED (state is held, not advanced) when
 *   the live timestamp check contradicts the verified server-clock conversion
 *   or when the instrument metadata the integer price scale depends on is
 *   missing or different. Raw data collection is unaffected (separate process).
 * - No broker order API is reachable: this module imports only research code.
 */
import type { ReplayState } from './replay';
import { SPEC, SPEC_HASH } from './spec';
import { iso } from './time';
import type { FirstReturnEvent, OutcomeStatus } from './types';
import { evaluateQuoteGate, ORDER_EXECUTION, type WatchState, type WatchStore } from './watch';

/** Recorded outcome of the 2026-09-15 verification pass (evidence in research-output/.../verification/). */
export const TIMESTAMP_BASIS = {
  interpretation: 'Stored MT5 bar/tick epochs are broker-server wall clock (IANA EET: UTC+2 winter, UTC+3 summer), converted to UTC at read time',
  status: 'VERIFIED',
  verifiedOn: '2026-09-15',
  evidence: [
    'live XAUUSD tick time/time_msc = external UTC + 3.000 h while advancing (mt5-live-time-evidence.json)',
    'position-based EURUSD M1 bar = UTC + 3.0 h (no datetime argument involved)',
    'collector EET-corrected live tick_at within seconds of backend receipt time',
    '2024-2025 break arithmetic: UTC+2 winter / +3 summer, EU-style DST; US-rule server rejected (break-arithmetic-observed.psv)',
  ],
  limitations: [
    'winter offset (+2) is inferred from historical break arithmetic, not live-measured',
    'EU vs Asia/Beirut DST rules are indistinguishable for stored bars (0 of 886,129 stored bars differ); US rules are rejected',
  ],
} as const;

export interface QuoteRow {
  symbol: string;
  bid: number;
  ask: number;
  /** Collector-converted tick time (UTC ms). */
  tickAtT: number;
  /** Backend receipt/update time (UTC ms, database clock). */
  receivedAtT: number;
}

export interface WatcherDeps {
  now(): number;
  latestM1CloseT(): Promise<number | null>;
  readQuotes(): Promise<QuoteRow[]>;
  readSymbolMetadata(): Promise<{ digits: number; tradeTickSize: number } | null>;
  readCollectorHeartbeat(): Promise<{ lastHeartbeatT: number; mt5Connected: boolean } | null>;
  /** Advances the replay through endT (a real run loads stored bars; tests pass synthetic data). `run` is opaque to the cycle. */
  advanceReplay(state: ReplayState | null, endT: number, observedAtT: number | null): Promise<{ state: ReplayState; dataHash: string; run?: unknown }>;
  /** Optional: quote-gated shadow summaries, computed after this cycle's gate decisions are recorded. */
  computeShadow?(run: unknown, state: WatchState): unknown;
}

export type LiveTimestampCheck = 'LIVE_CONSISTENT' | 'LIVE_CONTRADICTED' | 'LIVE_UNAVAILABLE';
export type EvaluationStatus =
  | 'EVALUATED_NEW_DATA'
  | 'WAITING_FOR_NEW_COMPLETED_DATA'
  | 'NO_GOLD_DATA'
  | 'BLOCKED_TIMESTAMP_CONTRADICTED'
  | 'BLOCKED_METADATA_MISSING'
  | 'BLOCKED_METADATA_MISMATCH';

export const LIVE_CHECK = { maxQuoteReceiptAgeMs: 10 * 60_000, minReceiptMinusTickMs: -5_000, maxReceiptMinusTickMs: 120_000 };
export const STALE_M1_AFTER_MS = 30 * 60_000;

/**
 * Uses the freshest quote received in the last 10 minutes: a correctly
 * converted tick time sits a few seconds before its backend receipt. An
 * hour-scale difference means the conversion no longer matches the broker.
 */
export function liveTimestampCheck(quotes: QuoteRow[], nowT: number): { status: LiveTimestampCheck; detail: string } {
  const fresh = quotes.filter((q) => nowT - q.receivedAtT <= LIVE_CHECK.maxQuoteReceiptAgeMs).sort((a, b) => b.receivedAtT - a.receivedAtT);
  if (!fresh.length) return { status: 'LIVE_UNAVAILABLE', detail: 'no quote received in the last 10 minutes (collector stopped, disconnected, or market closed)' };
  const q = fresh[0];
  const diff = q.receivedAtT - q.tickAtT;
  const detail = `${q.symbol}: received ${iso(q.receivedAtT)}, converted tick time ${iso(q.tickAtT)}, receipt - tick = ${(diff / 1000).toFixed(1)} s`;
  if (diff < LIVE_CHECK.minReceiptMinusTickMs || diff > LIVE_CHECK.maxReceiptMinusTickMs) return { status: 'LIVE_CONTRADICTED', detail };
  return { status: 'LIVE_CONSISTENT', detail };
}

export interface CycleResult {
  evaluation: EvaluationStatus;
  reason: string;
  newForwardEvents: number;
  statusChanges: number;
}

function journalFromState(store: WatchStore, state: WatchState): void {
  if (state.bootstrapSettledEndUtc) store.journalOnce('bootstrap', { type: 'BOOTSTRAP', settledEndUtc: state.bootstrapSettledEndUtc });
  const replay = state.replay;
  if (!replay) return;
  for (const id of replay.eventOrder) {
    const e = replay.events[id];
    if (e.observedAtT === null) continue; // historical bootstrap events are not forward observations
    store.journalOnce(`forward:${e.id}`, { type: 'FORWARD_FIRST_RETURN', orderExecution: ORDER_EXECUTION, event: e });
    const gate = state.quoteGate[e.id];
    if (gate) store.journalOnce(`gate:${e.id}`, { type: 'SHADOW_QUOTE_GATE', orderExecution: ORDER_EXECUTION, ...gate });
    if (e.outcome) store.journalOnce(`status:${e.id}:${e.outcome.status}`, { type: 'OUTCOME_STATUS', eventId: e.id, status: e.outcome.status });
  }
}

export async function runWatchCycle(store: WatchStore, deps: WatcherDeps): Promise<CycleResult & { summary: Record<string, unknown> }> {
  const nowT = deps.now();
  const state = store.load(nowT);
  journalFromState(store, state); // repairs any journal gap left by a crash after the previous save

  const [latestClose, quotes, metadata, heartbeat] = await Promise.all([
    deps.latestM1CloseT(),
    deps.readQuotes(),
    deps.readSymbolMetadata(),
    deps.readCollectorHeartbeat(),
  ]);
  const live = liveTimestampCheck(quotes, nowT);
  const gold = quotes.find((q) => q.symbol === SPEC.symbol) ?? null;

  let result: CycleResult;
  let shadow: unknown = null;
  const expectedTickSize = 1 / SPEC.data.priceUnitsPerDollar;

  if (!metadata) {
    result = { evaluation: 'BLOCKED_METADATA_MISSING', reason: 'no stored XAUUSD symbol metadata; the integer price scale cannot be confirmed', newForwardEvents: 0, statusChanges: 0 };
  } else if (Math.abs(metadata.tradeTickSize - expectedTickSize) > 1e-12 || metadata.digits !== 2) {
    result = { evaluation: 'BLOCKED_METADATA_MISMATCH', reason: `broker tick size ${metadata.tradeTickSize} / digits ${metadata.digits} differ from the frozen spec's ${expectedTickSize} / 2`, newForwardEvents: 0, statusChanges: 0 };
  } else if (live.status === 'LIVE_CONTRADICTED') {
    result = { evaluation: 'BLOCKED_TIMESTAMP_CONTRADICTED', reason: `live timestamp check contradicts the recorded conversion (${live.detail}); state held, nothing evaluated`, newForwardEvents: 0, statusChanges: 0 };
  } else if (latestClose === null) {
    result = { evaluation: 'NO_GOLD_DATA', reason: 'no stored XAUUSD M1 bars', newForwardEvents: 0, statusChanges: 0 };
  } else {
    const settledEndT = latestClose - SPEC.data.watchSettleMarginMinutes * 60_000;
    if (state.replay && state.settledEndT !== null && state.settledEndT >= settledEndT) {
      result = { evaluation: 'WAITING_FOR_NEW_COMPLETED_DATA', reason: `already evaluated through ${iso(state.settledEndT)}`, newForwardEvents: 0, statusChanges: 0 };
    } else {
      const bootstrap = state.replay === null;
      const before: Record<string, OutcomeStatus | null> = {};
      for (const e of Object.values(state.replay?.events ?? {})) before[e.id] = e.outcome?.status ?? null;

      const advanced = await deps.advanceReplay(state.replay, settledEndT, bootstrap ? null : nowT);
      const events = advanced.state.eventOrder.map((id) => advanced.state.events[id]);
      const newEvents = events.filter((e) => !(e.id in before));
      const statusChanges = events.filter((e) => e.id in before && before[e.id] !== (e.outcome?.status ?? null)).length;

      for (const e of newEvents) {
        if (bootstrap || !e.eligible || !e.selection?.isSelected || state.quoteGate[e.id]) continue;
        const quote = gold ? { bid: Math.round(gold.bid * 100), ask: Math.round(gold.ask * 100), tickT: gold.tickAtT, readAtT: nowT } : null;
        state.quoteGate[e.id] = evaluateQuoteGate(e, quote, nowT);
      }
      state.replay = advanced.state;
      state.settledEndT = settledEndT;
      if (bootstrap) state.bootstrapSettledEndUtc = iso(settledEndT);
      shadow = deps.computeShadow && advanced.run !== undefined ? deps.computeShadow(advanced.run, state) : null;
      result = {
        evaluation: 'EVALUATED_NEW_DATA',
        reason: `${bootstrap ? 'bootstrapped' : 'advanced'} through ${iso(settledEndT)} (data hash ${advanced.dataHash.slice(0, 12)})`,
        newForwardEvents: newEvents.filter((e: FirstReturnEvent) => e.observedAtT !== null).length,
        statusChanges,
      };
    }
  }

  state.lastCycleAtUtc = new Date(nowT).toISOString();
  store.save(state); // atomic; journal reconciliation below is idempotent
  journalFromState(store, state);
  if (result.evaluation === 'EVALUATED_NEW_DATA') store.journalOnce(`cycle:${state.settledEndT}`, { type: 'CYCLE', settledEndUtc: iso(state.settledEndT), ...result });

  const replay = state.replay;
  const events = replay ? replay.eventOrder.map((id) => replay.events[id]) : [];
  const summary = {
    mode: 'WATCH_ONLY',
    orderExecution: ORDER_EXECUTION,
    strategyVersion: SPEC.version,
    specHash: SPEC_HASH,
    lastCycleAtUtc: state.lastCycleAtUtc,
    evaluation: { status: result.evaluation, reason: result.reason },
    timestampVerification: { recorded: TIMESTAMP_BASIS, live },
    goldData: {
      latestStoredM1CloseUtc: iso(latestClose),
      latestStoredM1AgeSeconds: latestClose === null ? null : Math.round((nowT - latestClose) / 1000),
      stale: latestClose === null || nowT - latestClose > STALE_M1_AFTER_MS,
      note: 'stored times are converted from broker-server clock to UTC; the live collector currently ingests with a rolling lag of about the server offset (see verification report)',
    },
    quotes: quotes.map((q) => ({ ...q, tickAtUtc: iso(q.tickAtT), receivedAtUtc: iso(q.receivedAtT), receiptAgeSeconds: Math.round((nowT - q.receivedAtT) / 1000), spread: +(q.ask - q.bid).toFixed(5) })),
    collector: heartbeat
      ? { lastHeartbeatUtc: iso(heartbeat.lastHeartbeatT), ageSeconds: Math.round((nowT - heartbeat.lastHeartbeatT) / 1000), mt5Connected: heartbeat.mt5Connected }
      : null,
    symbolMetadata: metadata,
    settledEndUtc: iso(state.settledEndT),
    bootstrapSettledEndUtc: state.bootstrapSettledEndUtc,
    volumeLots: state.volumeLots,
    volumeAudit: state.volumeAudit,
    activeLevels: replay
      ? replay.levels.activeLevelIds.map((id) => replay.levels.levels[id]).map((l) => ({ id: l.id, role: l.role, price: (l.price / 100).toFixed(2), activatedUtc: iso(l.activatedT), h4BarsSinceActivation: l.barsSinceActivation }))
      : [],
    counts: {
      levelsEver: replay ? Object.keys(replay.levels.levels).length : 0,
      eventsEver: events.length,
      forwardEvents: events.filter((e) => e.observedAtT !== null).length,
      pendingOutcomes: replay ? replay.pendingRaceEventIds.length : 0,
    },
    quoteGate: state.quoteGate,
    shadow,
  };
  store.writeSummary(summary);
  return { ...result, summary };
}
