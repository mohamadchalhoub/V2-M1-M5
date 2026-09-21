/**
 * Who owns which XAUUSD position, and on what terms.
 *
 * Spec §2 and §10 require that migrating to the new strategy must not change
 * what happens to positions the OLD strategies opened: they keep their
 * original identity, their original protective distances, and their original
 * management, until they resolve on their own. A single shared registry is
 * what makes that enforceable rather than aspirational — every worker that
 * touches a position looks its magic number up here instead of assuming
 * "gold position, therefore mine".
 *
 * A position whose magic number is not listed here is FOREIGN: a manual
 * trade, another system's, or an unknown. Foreign exposure is displayed and
 * counted for occupancy (so the application never opens a second position
 * alongside one), but is never closed, never modified, and never adopted.
 */
import { RSI_MAGIC_EXTREME, RSI_MAGIC_RETEST, RSI_SL_USD, RSI_TP_USD } from './safety-constants';
import type { RuleFamily } from './pattern';
import { XAUUSD_RSI_STRATEGY_VERSION } from './spec';

export interface GoldPositionOwner {
  magicNumber: number;
  strategyVersion: string;
  /** Human label for dashboards, Telegram and incident text. */
  label: string;
  /** The protective distances THIS owner's positions are managed at, in USD of gold price. */
  takeProfitUsd: number;
  stopLossUsd: number;
  /** True only for the one currently enabled entry strategy. */
  isActiveStrategy: boolean;
  /**
   * Which execution slot this owner's positions occupy, for owners belonging
   * to the active strategy. Null for a retired strategy, whose positions are
   * still managed but compete for no slot.
   */
  ruleFamily: RuleFamily | null;
  /**
   * Whether this application may close or modify these positions.
   *
   * True for retired in-house strategies as well as the active one: spec §2
   * says old positions keep "their protective management until resolved",
   * and spec §9.3 explicitly includes "any explicitly registered old gold
   * position still managed during migration" in the Friday liquidation.
   */
  managedByThisApplication: boolean;
}

/**
 * The retired H4 confirmed-retest gold strategy. Its magic number and $10
 * brackets are reproduced here verbatim from
 * `gold-execution/gold-safety-constants.ts` so that a position it opened
 * before the migration is still recognised, still protected at the distance
 * it was opened with, and still liquidated on a Friday — without this module
 * importing anything from the archived strategy's own code.
 */
export const ARCHIVED_H4_CONFIRMED_RETEST_OWNER: GoldPositionOwner = {
  magicNumber: 262610181,
  strategyVersion: 'xauusd-h4-confirmed-retest-gold-live-v1',
  label: 'Archived H4 confirmed-retest gold (entries disabled)',
  takeProfitUsd: 10,
  stopLossUsd: 10,
  isActiveStrategy: false,
  ruleFamily: null,
  managedByThisApplication: true,
};

/**
 * The active strategy owns TWO magic numbers, one per execution slot, so an
 * open ticket identifies not just "this strategy" but which slot it holds.
 */
export const XAUUSD_RSI_RETEST_OWNER: GoldPositionOwner = {
  magicNumber: RSI_MAGIC_RETEST,
  strategyVersion: XAUUSD_RSI_STRATEGY_VERSION,
  label: 'XAUUSD M1 RSI — RETEST slot (active)',
  takeProfitUsd: RSI_TP_USD,
  stopLossUsd: RSI_SL_USD,
  isActiveStrategy: true,
  ruleFamily: 'RETEST',
  managedByThisApplication: true,
};

export const XAUUSD_RSI_EXTREME_OWNER: GoldPositionOwner = {
  magicNumber: RSI_MAGIC_EXTREME,
  strategyVersion: XAUUSD_RSI_STRATEGY_VERSION,
  label: 'XAUUSD M1 RSI — EXTREME slot (active)',
  takeProfitUsd: RSI_TP_USD,
  stopLossUsd: RSI_SL_USD,
  isActiveStrategy: true,
  ruleFamily: 'EXTREME',
  managedByThisApplication: true,
};

/**
 * Trend-breakout also traded XAUUSD. Its magic numbers come from that
 * module's own instrument config rather than a constant, so they cannot be
 * mirrored here reliably. It is therefore NOT registered: any position it
 * left behind is treated as foreign — displayed, counted for occupancy, and
 * never touched. That is the safe direction to fail, and it is disclosed on
 * the dashboard rather than silently adopted.
 */
export const GOLD_POSITION_OWNERS: readonly GoldPositionOwner[] = [
  XAUUSD_RSI_RETEST_OWNER,
  XAUUSD_RSI_EXTREME_OWNER,
  ARCHIVED_H4_CONFIRMED_RETEST_OWNER,
];

export function ownerForMagic(magic: number | null | undefined): GoldPositionOwner | null {
  if (magic === null || magic === undefined) return null;
  return GOLD_POSITION_OWNERS.find((o) => o.magicNumber === magic) ?? null;
}

export function isOwnedByThisApplication(magic: number | null | undefined): boolean {
  return ownerForMagic(magic)?.managedByThisApplication === true;
}

export function isActiveStrategyPosition(magic: number | null | undefined): boolean {
  return ownerForMagic(magic)?.isActiveStrategy === true;
}

/** Which slot an open position occupies, or null if it occupies none. */
export function ruleFamilyForMagic(magic: number | null | undefined): RuleFamily | null {
  return ownerForMagic(magic)?.ruleFamily ?? null;
}

/** Describes a position's ownership for dashboards, Telegram and audit records. */
export function describeOwnership(magic: number | null | undefined): string {
  const owner = ownerForMagic(magic);
  if (owner) return `${owner.label} (magic ${owner.magicNumber})`;
  return magic === null || magic === undefined
    ? 'foreign/manual position (no magic number reported) — never closed or modified by this application'
    : `foreign position (magic ${magic}, not registered to this application) — never closed or modified by this application`;
}
