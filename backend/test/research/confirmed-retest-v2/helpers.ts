// Synthetic fixture builders for the xauusd-h4-confirmed-retest-v2 specs.
// Copy of confirmed-retest/test helpers.ts pointed at the v2 types module
// (structurally identical Bar/EvalBar/GapInfo shapes) — kept separate so
// v1's tests are untouched.
// Prices are integer broker units (1 = $0.01): usd(2000) === 200000.
import type { Bar, EvalBar, GapInfo } from '../../../src/research/confirmed-retest-v2/types';

export const H4 = 4 * 3_600_000;
export const M1 = 60_000;
export const D1 = 86_400_000;

export const usd = (dollars: number): number => Math.round(dollars * 100);

export function bar(t: number | string, o: number, h: number, l: number, c: number, dur = M1): Bar {
  const time = typeof t === 'string' ? Date.parse(t) : t;
  return { t: time, dur, o: usd(o), h: usd(h), l: usd(l), c: usd(c) };
}

export function evalBar(t: number | string, o: number, h: number, l: number, c: number, opts: { dur?: number; gapBefore?: GapInfo | null; res?: EvalBar['res'] } = {}): EvalBar {
  return { ...bar(t, o, h, l, c, opts.dur ?? M1), res: opts.res ?? 'M1', gapBefore: opts.gapBefore ?? null };
}

/** A flat H4 background bar: body at 2000, wicks ±5. */
export function flatH4(t: number): Bar {
  return bar(t, 2000, 2005, 1995, 2000, H4);
}

/**
 * Builds `count` consecutive H4 bars starting at `startIso`, all flat, then
 * applies per-index overrides. Bars are contiguous (no gaps).
 */
export function h4Series(startIso: string, count: number, overrides: Record<number, Partial<{ o: number; h: number; l: number; c: number }>> = {}): Bar[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => {
    const base = flatH4(start + i * H4);
    const ov = overrides[i];
    if (!ov) return base;
    return {
      ...base,
      o: ov.o !== undefined ? usd(ov.o) : base.o,
      h: ov.h !== undefined ? usd(ov.h) : base.h,
      l: ov.l !== undefined ? usd(ov.l) : base.l,
      c: ov.c !== undefined ? usd(ov.c) : base.c,
    };
  });
}

export function gap(startT: number, endT: number, kind: GapInfo['kind'], bridge: [number, number] | null = null): GapInfo {
  return {
    id: `gap:${new Date(startT).toISOString()}`,
    startT,
    endT,
    kind,
    bridgeLow: bridge ? usd(bridge[0]) : null,
    bridgeHigh: bridge ? usd(bridge[1]) : null,
    evidence: 'fixture',
  };
}
