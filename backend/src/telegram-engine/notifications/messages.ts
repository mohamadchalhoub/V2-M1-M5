/**
 * Every alert Engine B sends, and the one rule they all obey.
 *
 * ## The header is not decoration
 *
 * Both engines trade XAUUSD on one account and both send alerts to the same
 * chats. An operator woken at 03:00 by "POSITION CLOSED -$14" needs to know,
 * in the first line, which system did it — because the answer decides whether
 * anything needs doing and which kill switch is the right one. So every
 * message this module produces begins with the same header, and the header is
 * produced by one function that every template calls rather than being typed
 * into each one.
 *
 * `engineBHeader()` is therefore the only place the identity string exists.
 * A template that forgot it would be a message an operator could mistake for
 * Engine A's, and `messages.spec.ts` asserts every exported builder includes
 * it.
 *
 * ## Only real values
 *
 * A field whose value is unknown is omitted, never filled with a plausible
 * one and never printed as "undefined". An alert is evidence about what
 * happened; a fabricated number in it is worse than a missing line.
 */
import { TELEGRAM_MAGIC } from '../safety-constants';
import { TELEGRAM_SPEC } from '../spec';
import type { Direction } from '../spec';

/** The mandatory first line. Nothing else may produce this string. */
export function engineBHeader(): string {
  return 'ENGINE B — TELEGRAM CHANNEL';
}

function header(icon: string, title: string): string {
  return `${icon} ${engineBHeader()}\n\n${title}`;
}

/** Source attribution, on every alert where a source message exists. */
function sourceLines(messageId?: string | null): string[] {
  const lines = [`Source: @${TELEGRAM_SPEC.sourceChannelUsername}`];
  if (messageId) lines.push(`Message ID: ${messageId}`);
  return lines;
}

/** Drops lines whose value could not be established. */
function compact(lines: readonly (string | null | undefined)[]): string {
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
}

function money(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
}

function seconds(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export interface ActivationFacts {
  readonly sourceChannelId: string;
  readonly accountMode: string;
  readonly mt5Ready?: boolean;
  readonly ingestionConnected?: boolean;
  readonly recoveryComplete?: boolean;
}

export function activationPendingMessage(facts: ActivationFacts): string {
  return compact([
    header('🟠', 'DEMO EXECUTION IS BEING ENABLED'),
    '',
    ...sourceLines(),
    `Source Channel ID: ${facts.sourceChannelId}`,
    `Account Mode: ${facts.accountMode}`,
    'Engine: Engine B',
    'Strategy: Telegram Channel',
    `Magic: ${TELEGRAM_MAGIC}`,
    `Volume: ${TELEGRAM_SPEC.lotsPerTakeProfit} lot per TP`,
    `Maximum Signal Age: ${TELEGRAM_SPEC.maxSignalAgeMs / 1000} seconds`,
    '',
    'Engine A: UNCHANGED',
    'Engine B: ACTIVATING',
    '',
    'Incoming valid Telegram BUY/SELL signals may now create DEMO MT5 orders.',
    '',
    'This is DEMO testing only.',
  ]);
}

export function activationCompleteMessage(facts: ActivationFacts): string {
  return compact([
    header('🟢', 'DEMO EXECUTION ENABLED'),
    '',
    ...sourceLines(),
    `Source Channel ID: ${facts.sourceChannelId}`,
    `Account Mode: ${facts.accountMode}`,
    `Magic: ${TELEGRAM_MAGIC}`,
    `Volume: ${TELEGRAM_SPEC.lotsPerTakeProfit} lot per TP`,
    `Maximum Signal Age: ${TELEGRAM_SPEC.maxSignalAgeMs / 1000} seconds`,
    '',
    'Status: ACTIVE',
    `MT5: ${facts.mt5Ready ? 'READY' : 'NOT READY'}`,
    `Telegram ingestion: ${facts.ingestionConnected ? 'CONNECTED' : 'NOT CONNECTED'}`,
    `Reconciliation: ${facts.recoveryComplete ? 'READY' : 'NOT READY'}`,
    '',
    'Engine A remains unchanged.',
    '',
    'Valid Engine B signals can now execute automatically on the DEMO account.',
  ]);
}

export function engineDisabledMessage(reason: string): string {
  return compact([
    header('🔴', 'EXECUTION DISABLED'),
    '',
    ...sourceLines(),
    '',
    `Reason: ${reason}`,
    '',
    'No new Telegram entries will be opened. Existing Telegram positions are',
    'still reconciled and still managed.',
    '',
    'Engine A is unaffected.',
  ]);
}

// ---------------------------------------------------------------------------
// Ingestion liveness
// ---------------------------------------------------------------------------

export function ingestionStateMessage(connected: boolean, detail: string): string {
  return compact([
    header(connected ? '🟢' : '🔴', connected ? 'INGESTION RECONNECTED' : 'INGESTION DISCONNECTED'),
    '',
    ...sourceLines(),
    '',
    detail,
    connected ? null : '',
    connected ? null : 'While disconnected, no Telegram signal can be received or executed.',
    connected ? null : 'Engine A is unaffected.',
  ]);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface SignalFacts {
  readonly messageId: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfits: readonly number[];
  readonly tp1: number;
  readonly publishedAtIso: string;
  readonly receivedAtIso: string;
  readonly ingestionLatencyMs: number | null;
  readonly signalAgeMs: number | null;
}

export function signalReceivedMessage(facts: SignalFacts): string {
  return compact([
    header('🔵', 'SIGNAL RECEIVED'),
    '',
    ...sourceLines(facts.messageId),
    '',
    `Side: ${facts.direction}`,
    `Entry: ${facts.entry}`,
    `SL: ${facts.stopLoss}`,
    '',
    ...facts.takeProfits.map((tp, i) => `TP${i + 1}: ${tp}`),
    '',
    `Published: ${facts.publishedAtIso}`,
    `Received: ${facts.receivedAtIso}`,
    facts.ingestionLatencyMs === null ? null : `Ingestion latency: ${Math.round(facts.ingestionLatencyMs)}ms`,
    facts.signalAgeMs === null ? null : `Signal age: ${seconds(facts.signalAgeMs)}`,
    '',
    `Planned orders: ${facts.takeProfits.length}`,
    `Volume per order: ${TELEGRAM_SPEC.lotsPerTakeProfit}`,
  ]);
}

export interface LegExecutionFacts {
  readonly legIndex: number;
  readonly legCount: number;
  readonly volumeLots: number;
  readonly takeProfit: number;
  readonly fillPrice: number | null;
  readonly ticket: string | null;
  readonly status: string;
}

export interface ExecutionFacts {
  readonly messageId: string;
  readonly direction: Direction;
  readonly sourceEntry: number;
  readonly stopLoss: number;
  readonly legs: readonly LegExecutionFacts[];
  readonly signalAgeAtExecutionMs: number | null;
  readonly mode: string;
}

/**
 * One alert per signal group, with every leg's own ticket and fill shown
 * separately.
 *
 * Deliberately NOT one alert per leg, and deliberately not a summary that
 * hides the tickets: the legs are one trade and belong together, but each is
 * an independent broker position that has to be identifiable from the alert
 * alone — otherwise an operator reconciling against the terminal cannot tell
 * which ticket belongs to which target.
 */
export function tradeExecutedMessage(facts: ExecutionFacts): string {
  const legBlocks = facts.legs.flatMap((leg) => [
    '',
    `LEG ${leg.legIndex}${leg.legCount > 1 ? `/${leg.legCount}` : ''}`,
    `Volume: ${leg.volumeLots}`,
    `TP: ${leg.takeProfit}`,
    leg.fillPrice === null ? `Status: ${leg.status}` : `Actual Fill: ${leg.fillPrice}`,
    leg.ticket === null ? null : `Ticket: ${leg.ticket}`,
    leg.fillPrice === null ? null : `Status: ${leg.status}`,
  ]);

  return compact([
    header('🟢', 'DEMO TRADE EXECUTED'),
    '',
    ...sourceLines(facts.messageId),
    '',
    `Side: ${facts.direction}`,
    `Signal Entry: ${facts.sourceEntry}`,
    `SL: ${facts.stopLoss}`,
    ...legBlocks,
    '',
    facts.signalAgeAtExecutionMs === null
      ? null
      : `Signal Age at Execution: ${seconds(facts.signalAgeAtExecutionMs)}`,
    `Mode: ${facts.mode}`,
  ]);
}

export interface ClosureFacts {
  readonly messageId: string | null;
  readonly legIndex: number;
  readonly legCount: number;
  readonly direction: Direction;
  readonly volumeLots: number;
  readonly entryFill: number | null;
  readonly exitPrice: number | null;
  readonly stopLoss: number;
  readonly takeProfit: number;
  /** Broker-confirmed realised result. Never inferred from source prices. */
  readonly realizedPl: number | null;
  readonly ticket: string | null;
}

export function positionClosedMessage(facts: ClosureFacts): string {
  const result = money(facts.realizedPl);
  return compact([
    header(facts.realizedPl !== null && facts.realizedPl < 0 ? '🔻' : '✅', 'POSITION CLOSED'),
    '',
    ...sourceLines(facts.messageId),
    `Leg: ${facts.legIndex}/${facts.legCount}`,
    '',
    `Side: ${facts.direction}`,
    `Volume: ${facts.volumeLots}`,
    facts.entryFill === null ? null : `Entry: ${facts.entryFill}`,
    facts.exitPrice === null ? null : `Exit: ${facts.exitPrice}`,
    `SL: ${facts.stopLoss}`,
    `TP: ${facts.takeProfit}`,
    '',
    // Omitted rather than guessed when the broker gave no figure. An invented
    // P/L in a closure alert is a number someone will later rely on.
    result === null ? 'Result: not established from broker evidence' : `Result: ${result}`,
    facts.ticket === null ? null : `Broker Ticket: ${facts.ticket}`,
  ]);
}

// ---------------------------------------------------------------------------
// Refusals, skips and incidents
// ---------------------------------------------------------------------------

/**
 * The single builder for every reason a signal did NOT trade.
 *
 * One function rather than fifteen, because the shape is identical and the
 * thing that must never vary — the header and the source attribution — should
 * not be re-typed fifteen times for fifteen chances to omit it.
 */
export function signalSkippedMessage(
  outcome: string,
  detail: string,
  facts: { messageId?: string | null; direction?: Direction | null; entry?: number | null },
): string {
  return compact([
    header('⚪', `SIGNAL NOT EXECUTED — ${outcome}`),
    '',
    ...sourceLines(facts.messageId),
    facts.direction && facts.entry ? `Signal: ${facts.direction} ${facts.entry}` : null,
    '',
    detail,
  ]);
}

export function protectionIncidentMessage(facts: {
  messageId: string | null;
  legIndex: number;
  ticket: string | null;
  detail: string;
}): string {
  return compact([
    header('🚨', 'PROTECTION INCIDENT'),
    '',
    ...sourceLines(facts.messageId),
    `Leg: ${facts.legIndex}`,
    facts.ticket === null ? null : `Broker Ticket: ${facts.ticket}`,
    '',
    facts.detail,
    '',
    'This position may be unprotected. It needs an operator.',
  ]);
}

export function reconciliationIncidentMessage(detail: string): string {
  return compact([
    header('🚨', 'RECONCILIATION INCIDENT'),
    '',
    ...sourceLines(),
    '',
    detail,
    '',
    `Engine B will not open new positions until this is resolved.`,
    'Engine A is unaffected.',
  ]);
}

export function uncertainExecutionMessage(facts: {
  messageId: string | null;
  legIndex: number;
  detail: string;
}): string {
  return compact([
    header('🚨', 'EXECUTION OUTCOME UNKNOWN'),
    '',
    ...sourceLines(facts.messageId),
    `Leg: ${facts.legIndex}`,
    '',
    facts.detail,
    '',
    'This leg MAY be a live position at the broker. It is not re-sent, and the',
    'signal group stays held until reconciliation establishes what happened.',
  ]);
}
