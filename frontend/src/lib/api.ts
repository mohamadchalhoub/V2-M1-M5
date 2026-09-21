// Server-only fetch layer — every page in this app is a Server Component,
// so these calls run on the Next.js server and talk to the backend
// directly (server-to-server), never from the browser. That sidesteps CORS
// entirely and means the backend API is never exposed to the client bundle.
const BASE_URL = process.env.BACKEND_API_URL ?? 'http://localhost:8420';

// Dashboard authentication (production-readiness review — Option B). Read
// from a server-only env var — deliberately NOT NEXT_PUBLIC_*, which Next.js
// inlines into the client bundle at build time; this one is only ever read
// here, on the server, and only ever sent as a header, never as a query
// param, never logged, never rendered into any page's HTML. This module's
// only client-side import anywhere (AccountSwitcher.tsx) is `import type`,
// which TypeScript erases entirely at compile time — the token itself never
// reaches the browser bundle regardless.
const DASHBOARD_API_TOKEN = process.env.DASHBOARD_API_TOKEN;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!DASHBOARD_API_TOKEN) {
    throw new Error('Missing required configuration: DASHBOARD_API_TOKEN. See frontend/.env.local.example.');
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    cache: 'no-store', // this is a monitoring dashboard — always read current state, never a stale cached page
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${DASHBOARD_API_TOKEN}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface Account {
  id: string;
  platform: 'MT5' | 'XTB';
  externalAccountId: string;
  broker: string | null;
  currency: string;
  displayName: string | null;
  isActive: boolean;
  tradingDayTimezone: string;
  tradingDayResetHour: number;
  createdAt: string;
}

export interface Snapshot {
  id: string;
  accountId: string;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  marginLevel: string | null;
  profit: string;
  capturedAt: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  openPrice: string;
  currentPrice: string | null;
  profit: string;
  swap: string;
  openedAt: string;
}

export interface Trade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  dealEntry: 'IN' | 'OUT';
  volume: string;
  price: string;
  commission: string;
  swap: string;
  profit: string;
  executedAt: string;
  comment: string | null;
  platform: 'MT5' | 'XTB';
}

export interface Paginated {
  total: number;
  limit: number;
  offset: number;
}

export type HealthComponent =
  | 'COLLECTOR'
  | 'MT5_TERMINAL'
  | 'DATABASE'
  | 'REDIS'
  | 'TELEGRAM'
  | 'AI_PROVIDER'
  | 'XTB_IMPORT'
  | 'DATA_INTEGRITY';

export type HealthStatusValue = 'OK' | 'DEGRADED' | 'DOWN';

export interface ComponentHealth {
  status: HealthStatusValue;
  detail: Record<string, unknown> | null;
  checkedAt: string | null;
}

export type HealthSnapshot = Record<HealthComponent, ComponentHealth>;

export interface HealthIncident {
  id: string;
  component: HealthComponent;
  statusFrom: HealthStatusValue;
  statusTo: HealthStatusValue;
  openedAt: string;
  resolvedAt: string | null;
  detail: Record<string, unknown> | null;
}

export interface RuleDefinition {
  id: string;
  accountId: string;
  name: string;
  ruleType: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
  cooldownSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  state: 'INACTIVE' | 'ACTIVE' | null;
}

export interface Alert {
  id: string;
  ruleId: string;
  accountId: string;
  triggeredAt: string;
  triggerValues: Record<string, unknown>;
  rule: { id: string; name: string; ruleType: string };
  delivery: { status: string; sentAt: string | null; attempts: number } | null;
  aiAnalysis: { status: string; result: unknown; safetyFlagged: boolean } | null;
}

export interface ImportBatch {
  id: string;
  accountId: string;
  fileSha256: string;
  fileName: string | null;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface EurUsdRoundTrip {
  positionId: string;
  side: 'BUY' | 'SELL';
  volume: number;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  profit: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface Candle {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface MarketDataCoverage {
  symbol: string;
  candles: Array<{
    timeframe: string;
    count: number;
    earliest: string | null;
    latest: string | null;
    intervalStatusCounts: Record<string, number>;
  }>;
  ticks: { count: number; earliest: string | null; latest: string | null; intervalStatusCounts: Record<string, number> };
  symbolMetadata: { present: boolean; updatedAt: string | null };
}

export interface TradeChartFeatures {
  preEntry: { returnPct: number | null; volatilityPct: number | null; recentHigh: number | null; recentLow: number | null; candleCount: number };
  duringTrade: { maxFavorableExcursionPct: number | null; maxAdverseExcursionPct: number | null; volatilityPct: number | null; candleCount: number };
  postExit: { continuationPct: number | null; candleCount: number };
}

export interface TradeChartWindow {
  positionId: string;
  symbol: string;
  timeframe: 'M5' | 'M15' | 'H1';
  side: 'BUY' | 'SELL';
  entryMarker: { time: string; price: number };
  exitMarker: { time: string; price: number; profit: number };
  stopLoss: number | null;
  takeProfit: number | null;
  candles: Candle[];
  features: TradeChartFeatures;
  dataLimitation: string | null;
}

export interface SupportResistanceLevel {
  timeframe: 'H1' | 'H4' | 'D1';
  type: 'SUPPORT' | 'RESISTANCE';
  price: number;
  method: 'FRACTAL_PIVOT';
  timestamp: string;
  touches: number;
}

export interface NearestSupportResistance {
  timeframe: 'H1' | 'H4' | 'D1';
  nearestSupport: SupportResistanceLevel | null;
  nearestResistance: SupportResistanceLevel | null;
}

export interface IchimokuStateWithTimeframe {
  timeframe: string;
  timestamp: string;
  close: number;
  spanA: number | null;
  spanB: number | null;
  position: 'ABOVE_CLOUD' | 'BELOW_CLOUD' | 'INSIDE_CLOUD' | 'INSUFFICIENT_DATA';
}

export interface FibonacciAnalysisReport {
  swingHigh: { price: number; timestamp: string };
  swingLow: { price: number; timestamp: string };
  direction: 'BULLISH' | 'BEARISH';
  levels: { ratio: number; price: number }[];
  currentPrice: number;
  nearestLevel: { ratio: number; price: number };
}

export interface MarketDirectionReport {
  symbol: string;
  dailyBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  reasons: string[];
  signals: { name: string; vote: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; reason: string }[];
  timeframes: string[];
  timestamp: string;
}

export interface TechnicalAnalysisReport {
  symbol: string;
  currentPrice: number;
  marketDirection: MarketDirectionReport;
  fibonacci: FibonacciAnalysisReport | null;
  supportResistance: NearestSupportResistance[];
  ichimoku: IchimokuStateWithTimeframe[];
  timestamp: string;
}

export interface TrendBreakoutVolumeSetting {
  instrument: 'EURUSD' | 'XAUUSD';
  volumeLots: number;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface TrendBreakoutInstrumentSettings {
  instrument: 'EURUSD' | 'XAUUSD';
  brokerSymbol: string;
  volume: TrendBreakoutVolumeSetting;
  slotOccupied: boolean;
  slotState: 'PENDING' | 'OPEN' | 'UNKNOWN' | null;
  symbolMetadataKnown: boolean;
}

export interface TrendBreakoutRiskPolicy {
  version: number;
  maxTradeRiskPct: number;
  maxCombinedRiskPct: number;
  dailyLossPct: number;
  drawdownPct: number;
  maxSpreadPctOfD: number;
  maxQuoteAgeSeconds: number;
}

export interface TrendBreakoutSettings {
  strategyVersion: string;
  instruments: TrendBreakoutInstrumentSettings[];
  entryWindow: { timezone: string; start: string; end: string };
  entryWindowCurrentlyOpen: boolean;
  riskPolicy: TrendBreakoutRiskPolicy;
  executionMode: string;
}

export interface TrendBreakoutVolumeAuditEntry {
  id: string;
  instrument: string;
  oldVolume: string | null;
  newVolume: string;
  newVersion: number;
  changedBy: string;
  changedAt: string;
}

export interface TrendBreakoutDecision {
  id: string;
  instrument: string;
  signalCloseAt: string;
  decisionAtUtc: string;
  decisionAtBeirut: string;
  action: 'OPEN_BUY' | 'OPEN_SELL' | 'HOLD';
  atr14: string | null;
  volumeUsed: string | null;
  estimatedStopRiskAmount: string | null;
  estimatedStopRiskCcy: string | null;
  intendedEntryPrice: string | null;
  intendedStopLoss: string | null;
  intendedTakeProfit: string | null;
  gateResults: { gate: string; passed: boolean; reason: string }[];
  rejectionReason: string | null;
  orderStatus: 'NONE' | 'PENDING' | 'SENT' | 'FILLED' | 'FAILED';
}

export const api = {
  listAccounts: () => apiFetch<Account[]>('/accounts'),
  getAccount: (id: string) => apiFetch<Account>(`/accounts/${id}`),
  latestSnapshot: (accountId: string) => apiFetch<Snapshot | null>(`/accounts/${accountId}/snapshots/latest`),
  openPositions: (accountId: string) => apiFetch<Position[]>(`/accounts/${accountId}/positions`),
  trades: (accountId: string, params: { limit?: number; offset?: number } = {}) =>
    apiFetch<{ trades: Trade[] } & Paginated>(
      `/accounts/${accountId}/trades?limit=${params.limit ?? 50}&offset=${params.offset ?? 0}`,
    ),
  rules: (accountId: string) => apiFetch<RuleDefinition[]>(`/accounts/${accountId}/rules`),
  alerts: (accountId: string, params: { limit?: number; offset?: number } = {}) =>
    apiFetch<{ alerts: Alert[] } & Paginated>(
      `/accounts/${accountId}/alerts?limit=${params.limit ?? 50}&offset=${params.offset ?? 0}`,
    ),
  health: () => apiFetch<HealthSnapshot>('/health'),
  healthIncidents: (component?: HealthComponent) =>
    apiFetch<HealthIncident[]>(`/health/incidents${component ? `?component=${component}` : ''}`),
  importBatches: (accountId: string) => apiFetch<ImportBatch[]>(`/xtb-import/batches/${accountId}`),
  importCsv: (input: { accountId: string; fileName: string; csvContent: string }) =>
    apiFetch<ImportBatch>('/xtb-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  eurUsdTrades: (accountId: string) => apiFetch<EurUsdRoundTrip[]>(`/accounts/${accountId}/eurusd-trades`),
  eurUsdTradeChart: (accountId: string, positionId: string) =>
    apiFetch<TradeChartWindow>(`/accounts/${accountId}/eurusd-trades/${encodeURIComponent(positionId)}/chart`),
  technicalAnalysis: (accountId: string) => apiFetch<TechnicalAnalysisReport | null>(`/accounts/${accountId}/technical-analysis`),
  trendBreakoutSettings: (accountId: string) => apiFetch<TrendBreakoutSettings>(`/accounts/${accountId}/trend-breakout/settings`),
  trendBreakoutVolumeAudit: (accountId: string, instrument: string) =>
    apiFetch<TrendBreakoutVolumeAuditEntry[]>(`/accounts/${accountId}/trend-breakout/volume-audit/${instrument}`),
  trendBreakoutDecisions: (accountId: string, params: { instrument?: string; limit?: number } = {}) =>
    apiFetch<TrendBreakoutDecision[]>(
      `/accounts/${accountId}/trend-breakout/decisions?limit=${params.limit ?? 30}${params.instrument ? `&instrument=${params.instrument}` : ''}`,
    ),
  updateTrendBreakoutVolume: (accountId: string, instrument: string, input: { volumeLots: number; changedBy: string }) =>
    apiFetch<{ ok: boolean; error?: string; warning?: string }>(`/accounts/${accountId}/trend-breakout/volume/${instrument}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  resetTrendBreakoutDrawdown: (accountId: string, resetBy: string) =>
    apiFetch<{ ok: boolean }>(`/accounts/${accountId}/trend-breakout/drawdown-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetBy }),
    }),
  marketCandles: (symbol: string, timeframe: string, from: string, to: string) =>
    apiFetch<{ symbol: string; timeframe: string; candles: Candle[] }>(
      `/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  marketCoverage: (symbol: string) =>
    apiFetch<MarketDataCoverage>(`/market-data/coverage?symbol=${encodeURIComponent(symbol)}`),
  // xauusd-m1-rsi-retest-extremes-v1 - the active strategy's own dashboard
  // and controls. Deliberately separate endpoints from the gold ones below,
  // which now serve only the retired strategy's remaining positions.
  xauusdRsiStatus: () => apiFetch<XauusdRsiStatus>('/research/xauusd-rsi-status'),
  xauusdRsiControls: () => apiFetch<XauusdRsiControls>('/research/xauusd-rsi-controls'),
  setXauusdRsiVolume: (volumeLots: number, note?: string) =>
    apiFetch<{ ok: boolean; volumeLots?: number; reason?: string }>('/research/xauusd-rsi-controls/volume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ volumeLots, note }),
    }),
  setXauusdRsiStopNewEntries: (active: boolean) =>
    apiFetch<{ ok: boolean; note?: string; warning?: string | null }>('/research/xauusd-rsi-controls/stop-new-entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active }),
    }),
  goldRetestResearch: () => apiFetch<GoldRetestResearch>('/research/xauusd-confirmed-retest'),
  goldExecutionStatus: () => apiFetch<GoldExecutionStatus>('/research/gold-execution-status'),
  goldNews: () => apiFetch<GoldNewsResponse>('/research/gold-execution-status/news'),
  goldAiSummaries: () => apiFetch<{ summaries: GoldAiSummary[] }>('/research/gold-execution-status/ai-summaries'),
  setGoldVolume: (input: { volumeLots: number; note?: string }) =>
    apiFetch<{ ok: boolean; volumeLots?: number; error?: string }>('/research/gold-execution-status/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  setGoldStopNewEntries: (active: boolean) =>
    apiFetch<{ ok: boolean; active: boolean }>('/research/gold-execution-status/stop-new-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    }),
  requestGoldClosePosition: (positionId: string) =>
    apiFetch<{ ok: boolean; error?: string; note?: string }>('/research/gold-execution-status/close-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId, confirm: true }),
    }),
};

// Gold (XAUUSD) DEMO execution dashboard — reads gold-dashboard.controller.ts's
// GET /research/gold-execution-status (and the two small read-only panels
// alongside it). Deliberately its own type block, loosely mirroring the
// controller's actual response shape rather than reusing any EURUSD/legacy
// dashboard type.
export interface GoldExecutionStatus {
  strategyVersion: string;
  accountMode?: 'OFF' | 'SHADOW' | 'DEMO';
  mode?: 'OFF' | 'SHADOW' | 'DEMO';
  stopNewEntriesActive: boolean;
  killSwitchActive: boolean;
  accountTradeMode?: 'REAL' | 'DEMO' | 'CONTEST' | null;
  error?: string;
  settings?: {
    symbol: string;
    /** The REAL volume every submitted order actually uses (frozen constant) — not the dashboard override below. */
    volumeLots: number;
    volumeOverride?: { value: number; active: boolean; note: string };
    magicNumber: number;
    tpSlUsd: number;
    pointSize: number;
    maxEntryDeviationPoints: number;
    riskCapsPct: { stopRisk: number; combined: number; dailyLoss: number; drawdown: number };
    note: string;
  };
  occupancy?: unknown;
  volumeConstraints?: { minLots: number; maxLots: number; stepLots: number };
  openPositions?: {
    ticket: string;
    side: 'BUY' | 'SELL';
    volume: number;
    entryPrice: number;
    currentPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    floatingPnl: number;
    openedAt: string;
    isProtected: boolean;
  }[];
  closedTrades?: { dealTicket: string; side: 'BUY' | 'SELL'; volume: number; price: number; realizedPnl: number; executedAt: string }[];
  recentDecisions?: {
    id: string;
    evaluatedAt: string;
    action: string;
    orderStatus: string;
    riskManagerApproved: boolean;
    riskManagerRejectionReason: string | null;
    reasoning: string;
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    mt5Ticket: number | null;
    filledPrice: number | null;
    executionError: string | null;
    /** When the underlying M1 touch actually closed — distinct from `evaluatedAt` (logging/replay time). Null if unavailable. */
    touchEndTIso: string | null;
  }[];
  recentNotifications?: { eventType: string; status: string; createdAt: string; text: string }[];
  collectorHeartbeat?: { lastHeartbeatAt: string | null; ageMs: number | null; stale: boolean; mt5Connected: boolean | null; lastError: string | null };
  liveQuote?: { bid: number | null; ask: number | null; ageMs: number | null; stale: boolean };
  entryWindow?: { timezone: string; startSecondsBeirut: number; endSecondsBeirutExclusive: number; open: boolean };
  dataFreshness?: { accountSnapshotAgeMs: number | null; accountSnapshotStale: boolean; symbolMetadataAgeMs: number | null; symbolMetadataStale: boolean };
  /** Standalone `scripts/gold-execution-scheduler.ts` process's own on-disk heartbeat — NOT this Nest app's uptime. `stale: true` means no recent cycle has been observed, regardless of whether the backend/dashboard itself is up. */
  goldScheduler?: { lastCycleAtUtc: string | null; ageMs: number | null; stale: boolean; activeLevelIds: string[] };
  eurusd?: { strategy: string; status: string; note: string };
}

export interface GoldNewsResponse {
  items: {
    id: string;
    title: string;
    category: 'ECONOMIC_EVENT' | 'NEWS';
    scheduledAtIso: string;
    scheduledAtBeirut: string;
    affectedCurrencies: string[];
    sentiment: string | null;
    sourceUrl: string | null;
  }[];
  coverage: {
    source: string;
    totalRows: number;
    mostRecentSourceDataAtIso: string | null;
    sourceDataStaleAfterMs: number;
    sourceDataStale: boolean;
    ingestionHealth: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
    lastIngestionRunAtIso: string | null;
    lastIngestionRunOutcome: 'completed' | 'failed' | null;
  }[];
}

export interface GoldAiSummary {
  id: string;
  eventType: string;
  sourceDataTimestampIso: string;
  generatedAtIso: string;
  provider: string;
  model: string | null;
  summary: string;
}

// xauusd-h4-confirmed-retest-v1 research artifacts (read-only; see
// backend/src/research/confirmed-retest/). Kept loosely typed where the
// shape is a pass-through of the run's JSON files.
type Range = [number, number] | null;

export interface RetestBucket {
  eligibleEvents: number;
  counts: Record<'WIN' | 'LOSS' | 'AMBIGUOUS' | 'INDETERMINATE' | 'UNRESOLVED', number>;
  resolvedWinRate: { numerator: number; denominator: number; rate: number | null; wilson95: [number, number] | null };
  allEligibleBounds: { low: number | null; high: number | null; lowFormula: string; highFormula: string };
}

export interface RetestPaperSummary {
  balanceId: string;
  costId: string;
  startingBalanceUsd: number;
  branches: number;
  branchCapHit: boolean;
  haltedBranches: number;
  openAtEndBranches: number;
  tradesEntered: Range;
  wins: Range;
  losses: Range;
  netPnlUsd: Range;
  netExpectancyUsdPerTrade: Range;
  profitFactor: Range;
  maxEquityDrawdownUsd: Range;
  maxEquityDrawdownPct: Range;
  exposurePct: Range;
  decisionTally: Record<string, Range>;
}

export interface GoldRetestResearch {
  strategyVersion: string;
  currentSpecHash: string;
  executionBoundary: string;
  watch: {
    orderExecution: 'NONE';
    lastCycleAtUtc: string;
    evaluation: { status: string; reason: string };
    timestampVerification: {
      recorded: { interpretation: string; status: string; verifiedOn: string; evidence: string[]; limitations: string[] };
      live: { status: 'LIVE_CONSISTENT' | 'LIVE_CONTRADICTED' | 'LIVE_UNAVAILABLE'; detail: string };
    };
    goldData: { latestStoredM1CloseUtc: string | null; latestStoredM1AgeSeconds: number | null; stale: boolean; note: string };
    quotes: Array<{ symbol: string; bid: number; ask: number; tickAtUtc: string; receivedAtUtc: string; receiptAgeSeconds: number; spread: number }>;
    collector: { lastHeartbeatUtc: string; ageSeconds: number; mt5Connected: boolean } | null;
    symbolMetadata: { digits: number; tradeTickSize: number } | null;
    settledEndUtc: string | null;
    volumeLots: number;
    volumeAudit: Array<{ atUtc: string; fromLots: number; toLots: number; changedBy: string }>;
    activeLevels: Array<{ id: string; role: string; price: string; activatedUtc: string; h4BarsSinceActivation: number }>;
    counts: { levelsEver: number; eventsEver: number; forwardEvents: number; pendingOutcomes: number };
    quoteGate: Record<string, { pass: boolean; reason: string; decidedAtUtc: string }>;
    watcher: { pid: number; startedAtUtc: string; cycle: number; loop: boolean; intervalSeconds: number; consecutiveErrors: number; nextCycleAtUtc: string | null } | null;
  } | null;
  run: {
    runId: string;
    specHashMatchesCurrent: boolean;
    manifest: { frozenEndUtc: string; studyStartUtc: string; warmupStartUtc: string; dataHash: string; runCommand: string; gitCommit: string; conclusion: { conclusion: string; reason: string } };
    eventStudy: {
      studyEventsByKind: Record<string, number>;
      ineligibleByReason: Record<string, number>;
      full: RetestBucket;
      byDirection: { BUY: RetestBucket; SELL: RetestBucket };
      byYear: Record<string, RetestBucket>;
      byHalfYear: Record<string, RetestBucket>;
      dependence: { note: string };
    };
    formation: {
      h4BarsProcessed: number;
      pivotCandidates: Record<string, number>;
      qualifiedPivots: Record<string, number>;
      rejectedNoRejectionClose: Record<string, number>;
      exactPriceRepeatPairsAnyDistance: Record<string, number>;
      exactPriceRepeatPairsInDistanceWindow: Record<string, number>;
      pairOutcomes: Record<string, number>;
      activationsBlocked: Record<string, number>;
      levelsActivated: Record<string, number>;
    };
    coverage: {
      validations: Array<{ timeframe: string; rows: number; firstUtc: string; lastUtc: string; nonCentPrices: number; ohlcViolations: number; gridMisaligned: number; weekendServerBars: number; timezoneConversionErrors: number }>;
      m1Gaps: { byKind: Record<string, { count: number; missingMinutes: number }>; unconfirmedList: Array<{ id: string; startUtc: string; minutes: number; kind: string; evidence: string; bridge: string | null }> };
      substitutedM5Bars: number;
      h4VsM1: { h4BarsChecked: number; exactMatch: number; mismatch: number; noM1Inside: number };
      provenance: { storedTicks: number; accountSnapshots: number; backfillLogInstrumentVerification: string };
    };
    paper: Array<{ summary: RetestPaperSummary; decisionsByEvent: Record<string, Record<string, number>> }>;
    levels: Array<Record<string, string | number | boolean | null>>;
    events: Array<Record<string, unknown>>;
  } | null;
}


// ---------------------------------------------------------------------------
// xauusd-m1-rsi-retest-extremes-v1 - the application's single enabled entry
// strategy. Shapes mirror xauusd-rsi/dashboard.controller.ts exactly. Fields
// the backend can legitimately report as unknown are nullable here, because
// the page must be able to SAY unknown rather than imply a value it does not
// actually have.
// ---------------------------------------------------------------------------

export interface XauusdRsiPatternPhase {
  phase: string;
  runningExtreme: number | null;
  frozenExtreme: number | null;
}

export interface XauusdRsiExposureItem {
  kind: string;
  ticket: string;
  side: string;
  volume: number;
  magicNumber: number | null;
  owned: boolean;
  ruleFamily: 'RETEST' | 'EXTREME' | null;
  openPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  description: string;
}

export interface XauusdRsiStatus {
  strategy: {
    version: string;
    specHash: string;
    symbol: string;
    timeframe: string;
    magicNumbers: { RETEST: number; EXTREME: number };
    executionMode: 'OFF' | 'SHADOW' | 'DEMO';
    isTheOnlyEnabledEntryStrategy: boolean;
  };
  demo: {
    accountId: string | null;
    tradeMode: string;
    demoVerified: boolean;
    equity: number | null;
    accountCurrency: string | null;
    marginMode: string;
    supportsTwoIndependentPositions: boolean;
    marginModeNote: string;
  };
  slots: {
    RETEST: { occupied: boolean | null; reason: string | null; holders: XauusdRsiExposureItem[] };
    EXTREME: { occupied: boolean | null; reason: string | null; holders: XauusdRsiExposureItem[] };
    maxConcurrentPositions: number;
    note: string;
    reservedStopRisk: { amount: number; count: number; note: string } | null;
  };
  indicator: {
    period: number;
    appliedPrice: string;
    smoothing: string;
    appliedPriceProvenance: string;
    parityVerified: boolean;
    parityMaxAbsDifference: number;
    paritySource: string;
    currentRsi: number | null;
    warmedUp: boolean;
    warmupBarsRequired: number;
    closedBarsApplied: number;
    flatPriceBehaviourNote: string;
  };
  thresholds: {
    sell2: number;
    sell1: number;
    buy1: number;
    buy2: number;
    extremeSell: number;
    extremeBuy: number;
    note: string;
  };
  patternState: {
    sellPeakRetest: XauusdRsiPatternPhase;
    buyTroughRetest: XauusdRsiPatternPhase;
    extremeSell: { phase: string };
    extremeBuy: { phase: string };
    previousRsi: number | null;
    observationCount: number;
  } | null;
  quote: {
    bid: number | null;
    ask: number | null;
    tickAt: string | null;
    ageSeconds: number | null;
    fresh: boolean;
    /** Which stream this quote came from. Optional: older backends omit it. */
    source?: 'live_ticks' | 'historical_ticks' | null;
    /** Server instant the age was measured against, so it can be checked. */
    evaluatedAt?: string;
    blockedReason?: string | null;
    considered?: Array<{ source: string; ageSeconds: number | null; rejected: string | null }>;
  };
  observation: {
    mode: string;
    modeLimitation: string;
    ticksApplied: number;
    duplicatesRejected: number;
    outOfOrderRejected: number;
    gapResets: number;
    needsReseed: boolean;
    cursor: unknown;
    cadence: {
      targetMs: number;
      samples: number;
      medianMs: number | null;
      p95Ms: number | null;
      maxMs: number | null;
      withinTarget: boolean | null;
      detail: string;
    };
  };
  schedule: {
    timeZone: string;
    nowBeirut: string;
    state: string;
    entriesAllowed: boolean;
    blockReason: string | null;
    detail: string;
    dailyPause: string;
    fridayEntryCutoff: string;
    fridayClosureDeadline: string;
    nextEligibleAt: string | null;
    nextEligibleLabel: string;
    nextFridayDeadline: { iso: string; beirut: string } | null;
    currentFridayDeadline: { iso: string; beirut: string } | null;
    inWeekendWindow: boolean;
  };
  /**
   * Added after the rest of this payload, so a backend that predates it
   * simply omits it. Optional on purpose — the dashboard must render
   * against an older backend rather than crash, which is exactly what it
   * did when the page hot-reloaded ahead of a backend restart.
   */
  /** Optional for the same reason as entryEligibility: it postdates the rest. */
  telegramDelivery?: {
    failedPending: number;
    gaveUp: number;
    oldestFailedAgeSeconds: number | null;
    lastError: string | null;
  };
  entryEligibility?: {
    canEnterNow: boolean;
    blockingGates: string[];
    gates: Array<{ gate: string; passed: boolean; detail: string }>;
    evaluatedLater: string[];
    note: string;
  };
  brokerSession: { open: boolean | null; detail: string };
  liquidation: {
    phase: string;
    detail: string;
    deadline: { iso: string; beirut: string } | null;
    outstandingItems: Array<{
      ticket: string;
      kind: string;
      status: string;
      attempts: number;
      lastError: string | null;
      deadline: string;
      ownership: string;
    }>;
    ownedExposureFlat: boolean | null;
  };
  exposure: {
    owned: XauusdRsiExposureItem[];
    foreign: XauusdRsiExposureItem[];
    occupancyBlocksNewEntries: boolean;
  };
  order: {
    volumeLots: number;
    volumeSource: string;
    volumeSourceDetail: string;
    defaultVolumeLots: number;
    takeProfitUsd: number;
    stopLossUsd: number;
    pointSize: number;
    maxEntryDeviationPoints: number;
    brokerConstraints: {
      minLots: number;
      maxLots: number;
      stepLots: number;
      stopsLevelPoints: number | null;
      freezeLevelPoints: number | null;
      tickSize: number | null;
    };
    bracketNote: string;
  };
  risk: {
    stopRiskCapPct: number;
    combinedRiskCapPct: number;
    dailyLossCapPct: number;
    drawdownCapPct: number;
    current: {
      equity: number;
      todaysLossAmount: number;
      currentDrawdownPct: number;
      existingCombinedRiskAmount: number;
      contractSize: number | null;
      profitCurrency: string;
      conversionRate: number | null;
    } | null;
  };
  controls: {
    killSwitchActive: boolean;
    killSwitchSource: string | null;
    stopNewEntriesActive: boolean;
    stopNewEntriesSource: string | null;
  };
  heartbeats: {
    strategyWatch: { lastCycleAtUtc: string | null; ageSeconds: number | null; stale: boolean; running: boolean; detail: string };
    collector: { lastHeartbeatAt: string | null; ageSeconds: number | null; stale: boolean; mt5Connected: boolean; lastError: string | null };
  };
  recentDecisions: Array<{
    id: string;
    evaluatedAt: string;
    observedAt: string;
    direction: string;
    ruleFamily?: 'RETEST' | 'EXTREME';
    setupKinds: string[];
    rsi: number;
    previousRsi: number | null;
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    volumeLots: number | null;
    orderStatus: string;
    approved: boolean;
    skipReason: string | null;
    reasoning: string;
    ticket: string | null;
    filledPrice: number | null;
    slippagePoints: number | null;
    brokerStopLoss: number | null;
    brokerTakeProfit: number | null;
    executionError: string | null;
  }>;
  confirmedEntries: {
    count: number;
    items: Array<{
      id: string;
      ticket: string | null;
      filledAt: string | null;
      filledPrice: number | null;
      requestedPrice: number | null;
      slippagePoints: number | null;
      requestedStopLoss: number | null;
      brokerStopLoss: number | null;
      requestedTakeProfit: number | null;
      brokerTakeProfit: number | null;
      protectionMatchesRequest: boolean | null;
    }>;
  };
}

export interface XauusdRsiControls {
  volume: { volumeLots: number; source: string; sourceDetail: string };
  volumeAudit: Array<{ at: string; oldValue: number; newValue: number; note: string }>;
  brokerConstraints: { minLots: number; maxLots: number; stepLots: number };
  killSwitch: { active: boolean; source: string | null };
  stopNewEntries: { active: boolean; source: string | null };
  brackets: { stopLossPoints: number; takeProfitPoints: number };
}
