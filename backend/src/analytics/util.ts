import { Decimal } from '@prisma/client/runtime/library';

/** Rounds to 2 decimal places, matching this schema's money/volume precision. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Rounds to 4 decimal places — used for fractions (win rate, drawdown), not money. */
export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function decimalToNumber(value: Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return value instanceof Decimal ? value.toNumber() : value;
}

/** `netProfit = profit + commission + swap` (ANALYTICS_SPEC.md §0 — Gross vs. net). */
export function netProfitOf(deal: {
  profit: Decimal | number;
  commission: Decimal | number;
  swap: Decimal | number;
}): number {
  return decimalToNumber(deal.profit) + decimalToNumber(deal.commission) + decimalToNumber(deal.swap);
}

export const CLOSING_DEAL_ENTRIES = ['OUT', 'INOUT', 'OUT_BY'] as const;
