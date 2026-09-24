/**
 * Who owns which XAUUSD position, for `xauusd-sar-v1` (Engine A replacement).
 *
 * One magic number, one owner. A position whose magic is not `SAR_MAGIC` is
 * FOREIGN — including every legacy RSI M1/M5 position, every other strategy
 * on this account, and every Engine B position. Foreign is the safe default:
 * this code counts it for exposure awareness where relevant, but never
 * closes, modifies, adopts or relabels it.
 */
import { SAR_FOREIGN_MAGIC_NUMBERS, SAR_MAGIC } from './safety-constants';
import { XAUUSD_SAR_STRATEGY_VERSION } from './spec';

export interface SarPositionOwner {
  readonly magicNumber: number;
  readonly strategyVersion: string;
  readonly label: string;
}

export const SAR_OWNER: SarPositionOwner = {
  magicNumber: SAR_MAGIC,
  strategyVersion: XAUUSD_SAR_STRATEGY_VERSION,
  label: 'xauusd-sar-v1',
};

export function isOwnedBySar(magic: number | null | undefined): boolean {
  return magic === SAR_MAGIC;
}

export function isKnownForeign(magic: number | null | undefined): boolean {
  return magic !== null && magic !== undefined && SAR_FOREIGN_MAGIC_NUMBERS.includes(magic);
}

/** Asserts at boot that this strategy's magic collides with nothing known. */
export function assertEngineSeparation(): void {
  if (SAR_FOREIGN_MAGIC_NUMBERS.includes(SAR_MAGIC)) {
    throw new Error(`xauusd-sar magic ${SAR_MAGIC} appears in its own foreign-magic list. This is a code defect.`);
  }
}
