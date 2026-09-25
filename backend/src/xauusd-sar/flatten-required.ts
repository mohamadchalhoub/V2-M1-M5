/**
 * "Flatten required": an operator marker that takes precedence over the
 * strategy. While present, evaluateTick does nothing (no entry, no
 * reversal) and the scheduler's only permitted action is to flatten the
 * named position through closeForDay, once the market is tradeable and the
 * broker position matches the recorded identity exactly.
 *
 * Same mechanism and location as the SAR kill switch: a file in the runtime
 * volume shared by the API (watchdog) and the scheduler.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStateDir } from '../xauusd-m1m5/state-store';
import { SAR_MAGIC } from './safety-constants';

export interface FlattenRequired {
  readonly ticket: string;
  readonly side: 'BUY' | 'SELL';
  readonly volume: number;
  readonly reason: string;
}

export function getFlattenRequiredPath(): string {
  return process.env.XAUUSD_SAR_FLATTEN_REQUIRED_PATH?.trim() || join(defaultStateDir(), 'XAUUSD_SAR_FLATTEN_REQUIRED');
}

/** Present-but-unreadable counts as required: it must never read as "absent". */
export function readFlattenRequired(): FlattenRequired | 'UNREADABLE' | null {
  const path = getFlattenRequiredPath();
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<FlattenRequired>;
    if (typeof v.ticket !== 'string' || (v.side !== 'BUY' && v.side !== 'SELL') || typeof v.volume !== 'number') return 'UNREADABLE';
    return { ticket: v.ticket, side: v.side, volume: v.volume, reason: String(v.reason ?? '') };
  } catch {
    return 'UNREADABLE';
  }
}

export interface BrokerSarPosition {
  readonly ticket: string;
  readonly side: string;
  readonly volume: number;
  readonly magic: number | null;
  readonly symbol: string;
}

/** Empty array = identity confirmed; otherwise every discrepancy found. */
export function checkFlattenIdentity(
  expected: FlattenRequired,
  sarPositions: readonly BrokerSarPosition[],
  sessionTicket: string | null,
): string[] {
  const problems: string[] = [];
  if (sarPositions.length !== 1) problems.push(`expected exactly 1 SAR position at the broker, found ${sarPositions.length}`);
  const p = sarPositions.find((x) => x.ticket === expected.ticket);
  if (!p) {
    problems.push(`ticket ${expected.ticket} is not an open SAR position at the broker`);
  } else {
    if (p.symbol !== 'XAUUSD') problems.push(`symbol ${p.symbol}, expected XAUUSD`);
    if (p.side !== expected.side) problems.push(`side ${p.side}, expected ${expected.side}`);
    if (Math.abs(p.volume - expected.volume) > 1e-9) problems.push(`volume ${p.volume}, expected ${expected.volume}`);
    if (p.magic !== SAR_MAGIC) problems.push(`magic ${p.magic}, expected ${SAR_MAGIC}`);
  }
  if (sessionTicket !== expected.ticket) problems.push(`SAR session owns ticket ${sessionTicket ?? 'none'}, expected ${expected.ticket}`);
  return problems;
}

export type CloseWindowAction = 'NONE' | 'WAIT_FOR_TRADEABLE_MARKET' | 'IDENTITY_MISMATCH' | 'FLATTEN';

/**
 * What the scheduler may do while inside the close window or while a
 * flatten is required. Never submits while the market is not tradeable:
 * MT5 rejects every order then ("Market closed"), and the requirement to
 * flatten is kept, not treated as done.
 */
export function closeWindowAction(i: {
  readonly sessionState: string | null;
  readonly marketTradeable: boolean;
  readonly flattenRequired: boolean;
  readonly identityProblems: readonly string[];
}): CloseWindowAction {
  if (i.sessionState === null || i.sessionState === 'DAILY_CLOSED') return 'NONE';
  if (!i.marketTradeable) return 'WAIT_FOR_TRADEABLE_MARKET';
  if (i.flattenRequired && i.identityProblems.length > 0) return 'IDENTITY_MISMATCH';
  return 'FLATTEN';
}
