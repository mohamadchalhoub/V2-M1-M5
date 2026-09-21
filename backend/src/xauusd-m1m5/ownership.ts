/**
 * Who owns which XAUUSD position, and on what terms (§1, §4, §9.3).
 *
 * This strategy runs on its own DEMO account, but the ownership question is
 * not therefore trivial, and getting it wrong is the highest-consequence
 * mistake available to this codebase. Two constraints make a single shared
 * registry the only defensible design:
 *
 * 1. §4 — closing or remediating M1 must never target M5. The two timeframes
 *    hold independent positions that differ in no observable way except
 *    their magic number, so every worker that touches a position looks it up
 *    here rather than assuming "gold position, therefore mine".
 * 2. §1/§9.3 — the previous M1 revision-5 bot is STILL RUNNING and the
 *    legacy deployment still exists. Should this strategy ever observe a
 *    position belonging to either, or any manual trade, it must display it,
 *    count it for exposure, and never close, modify, adopt or relabel it.
 *
 * A position whose magic number is not registered here as owned is FOREIGN.
 * Foreign is the safe default and the default that applies to anything
 * unrecognised.
 */
import {
  V2_MAGIC_M1,
  V2_MAGIC_M5,
  V2_FOREIGN_MAGIC_NUMBERS,
  V2_SL_USD,
  V2_TP_USD,
  v2TimeframeForMagic,
} from './safety-constants';
import { XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from './spec';

export interface PositionOwner {
  readonly magicNumber: number;
  readonly strategyVersion: string;
  /** Human label for dashboards, Telegram and incident text. */
  readonly label: string;
  /** Which execution path this owner's positions occupy. */
  readonly timeframe: Timeframe;
  /** Protective distances these positions are managed at, in USD of gold price. */
  readonly takeProfitUsd: number;
  readonly stopLossUsd: number;
  /** Whether THIS application may close or modify these positions. */
  readonly managedByThisApplication: boolean;
}

export const V2_M1_OWNER: PositionOwner = {
  magicNumber: V2_MAGIC_M1,
  strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
  label: 'XAUUSD M1/M5 RSI threshold v2 — M1 path',
  timeframe: 'M1',
  takeProfitUsd: V2_TP_USD,
  stopLossUsd: V2_SL_USD,
  managedByThisApplication: true,
};

export const V2_M5_OWNER: PositionOwner = {
  magicNumber: V2_MAGIC_M5,
  strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
  label: 'XAUUSD M1/M5 RSI threshold v2 — M5 path',
  timeframe: 'M5',
  takeProfitUsd: V2_TP_USD,
  stopLossUsd: V2_SL_USD,
  managedByThisApplication: true,
};

/**
 * The COMPLETE set of positions this application may act on. Deliberately
 * exactly two entries.
 *
 * Note what is NOT here: the previous strategy's 262610190/262610191, the
 * archived H4 gold strategy's 262610181, and the legacy EURUSD strategy's
 * 262610180. Earlier revisions of this codebase registered retired in-house
 * strategies as "managed" so that migration could keep protecting their open
 * positions. That reasoning does not carry over, because this is not a
 * migration: the previous bot has not been retired, it is running right now
 * on its own account and managing its own positions. Registering its magic
 * numbers here would let this application close a live position belonging to
 * a system it does not own, which §1 forbids absolutely.
 */
export const V2_POSITION_OWNERS: readonly PositionOwner[] = [V2_M1_OWNER, V2_M5_OWNER];

export function ownerForMagic(magic: number | null | undefined): PositionOwner | null {
  if (magic === null || magic === undefined) return null;
  return V2_POSITION_OWNERS.find((o) => o.magicNumber === magic) ?? null;
}

/** True only for the two magic numbers this strategy opened itself. */
export function isOwnedByThisApplication(magic: number | null | undefined): boolean {
  return ownerForMagic(magic) !== null;
}

/** Which timeframe path a position occupies, or null if it occupies none of ours. */
export function timeframeForPosition(magic: number | null | undefined): Timeframe | null {
  return ownerForMagic(magic)?.timeframe ?? null;
}

export type ForeignKind = 'OTHER_BOT' | 'MANUAL_OR_UNKNOWN';

export interface ForeignPosition {
  readonly kind: ForeignKind;
  readonly detail: string;
}

/**
 * Classifies a non-owned position, so the dashboard and incident text can be
 * specific about WHY something is untouchable rather than lumping everything
 * into "not ours".
 */
export function classifyForeign(magic: number | null | undefined): ForeignPosition | null {
  if (isOwnedByThisApplication(magic)) return null;
  if (magic !== null && magic !== undefined && V2_FOREIGN_MAGIC_NUMBERS.includes(magic)) {
    return {
      kind: 'OTHER_BOT',
      detail:
        `Position belongs to another trading application (magic ${magic}) that manages its own exposure. ` +
        'This application never closes, modifies, adopts or relabels it.',
    };
  }
  return {
    kind: 'MANUAL_OR_UNKNOWN',
    detail:
      magic === null || magic === undefined
        ? 'Manual or unattributable position (no magic number reported) — never closed or modified by this application.'
        : `Unregistered position (magic ${magic}) — never closed or modified by this application.`,
  };
}

/**
 * MT5's magic number arrives inside a position's raw payload — there is no
 * dedicated column on `Position`.
 *
 * This strategy keeps its own copy rather than importing the retired
 * strategy's identical helper: §1 requires this application not to depend on
 * retired code staying in place, and ownership attribution is the last thing
 * that should break because someone deleted a module this one quietly relied
 * on.
 *
 * A null magic is NEVER treated as a match for any owner — an unattributable
 * position is foreign, which is the safe direction.
 */
export function extractMagic(rawPayload: unknown): number | null {
  if (typeof rawPayload !== 'object' || rawPayload === null) return null;
  const magic = (rawPayload as Record<string, unknown>).magic;
  return typeof magic === 'number' && Number.isFinite(magic) ? magic : null;
}

/** Describes a position's ownership for dashboards, Telegram and audit records. */
export function describeOwnership(magic: number | null | undefined): string {
  const owner = ownerForMagic(magic);
  if (owner) return `${owner.label} (magic ${owner.magicNumber})`;
  return classifyForeign(magic)!.detail;
}

/**
 * Startup assertion (§14 — "Confirm unused magic numbers and ownership").
 *
 * Fails loudly rather than trading into a collision. Called during module
 * initialization so a mistaken constant cannot reach the broker.
 */
export function assertMagicNumbersAreDisjoint(): void {
  const ours = [V2_MAGIC_M1, V2_MAGIC_M5];
  if (new Set(ours).size !== ours.length) {
    throw new Error(`V2 magic numbers must be distinct per timeframe, got ${ours.join(', ')}`);
  }
  const collision = ours.find((m) => V2_FOREIGN_MAGIC_NUMBERS.includes(m));
  if (collision !== undefined) {
    throw new Error(
      `V2 magic number ${collision} collides with a magic number known to belong to another trading ` +
        'application on this broker. Refusing to start: a shared magic number makes position ownership ' +
        'unattributable and could let this application close a position it does not own.',
    );
  }
  if (v2TimeframeForMagic(V2_MAGIC_M1) !== 'M1' || v2TimeframeForMagic(V2_MAGIC_M5) !== 'M5') {
    throw new Error('V2 magic-number-to-timeframe mapping is inconsistent.');
  }
}
