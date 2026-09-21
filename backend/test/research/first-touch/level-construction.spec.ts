// Scenario 4 (part 1): the no-look-ahead invariant is enforced IN CODE by
// createLevel, not just documented — a level whose establishedAt predates
// the close of its own confirming data must be rejected.
import { describe, expect, it } from 'vitest';
import { createLevel, getLevelNominalPrice, getLevelZone, LookAheadViolationError } from '../../../src/research/first-touch/engine';
import { h4Candle } from './helpers';

describe('createLevel — no-look-ahead invariant', () => {
  it('succeeds when establishedAt is exactly the close of the last confirming candle', () => {
    const confirming = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({
      id: 'lvl-1',
      role: 'SUPPORT',
      price: 2000,
      sourceCandles: [confirming],
      establishedAt: confirming.closeTime, // exactly at the boundary — allowed (inclusive)
      methodVersion: 'test-v1',
    });
    expect(level.establishedAt.toISOString()).toBe(confirming.closeTime.toISOString());
    expect(level.history).toEqual([]);
  });

  it('succeeds when establishedAt is after the close of the last confirming candle', () => {
    const confirming = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({
      id: 'lvl-2',
      role: 'RESISTANCE',
      price: 2010,
      sourceCandles: [confirming],
      establishedAt: new Date(confirming.closeTime.getTime() + 60_000),
      methodVersion: 'test-v1',
    });
    expect(level.id).toBe('lvl-2');
  });

  it('REJECTS (throws LookAheadViolationError) a level whose establishedAt predates its own confirming data', () => {
    // Two H4 candles confirm this pivot; the method needed both bars closed
    // to confirm it. establishedAt here is set to the OPEN of the last
    // confirming candle — one bar-close too early — which must be rejected,
    // not silently clamped forward (see engine.ts createLevel doc for why
    // reject was chosen over clamp).
    const first = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const second = h4Candle('2026-01-01T04:00:00.000Z', 2005, 2012, 2000, 2008);

    expect(() =>
      createLevel({
        id: 'lvl-bad',
        role: 'SUPPORT',
        price: 2000,
        sourceCandles: [first, second],
        establishedAt: second.openTime, // predates second.closeTime — look-ahead
        methodVersion: 'test-v1',
      }),
    ).toThrow(LookAheadViolationError);
  });

  it('rejects a level with neither price nor zone, and one with both', () => {
    const confirming = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    expect(() =>
      createLevel({ id: 'x', role: 'SUPPORT', sourceCandles: [confirming], establishedAt: confirming.closeTime, methodVersion: 'v1' }),
    ).toThrow();
    expect(() =>
      createLevel({
        id: 'y',
        role: 'SUPPORT',
        price: 2000,
        zone: { lower: 1999, upper: 2001 },
        sourceCandles: [confirming],
        establishedAt: confirming.closeTime,
        methodVersion: 'v1',
      }),
    ).toThrow();
  });

  it('rejects a level with no source candles at all', () => {
    expect(() =>
      createLevel({ id: 'z', role: 'SUPPORT', price: 2000, sourceCandles: [], establishedAt: new Date(), methodVersion: 'v1' }),
    ).toThrow();
  });

  it('getLevelZone/getLevelNominalPrice treat a plain price as a zero-width zone', () => {
    const confirming = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'w', role: 'SUPPORT', price: 2000, sourceCandles: [confirming], establishedAt: confirming.closeTime, methodVersion: 'v1' });
    expect(getLevelZone(level)).toEqual({ lower: 2000, upper: 2000 });
    expect(getLevelNominalPrice(level)).toBe(2000);
  });

  it('getLevelNominalPrice uses the zone midpoint when a zone is supplied', () => {
    const confirming = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({
      id: 'zone-1',
      role: 'RESISTANCE',
      zone: { lower: 1998, upper: 2002 },
      sourceCandles: [confirming],
      establishedAt: confirming.closeTime,
      methodVersion: 'v1',
    });
    expect(getLevelNominalPrice(level)).toBe(2000);
  });
});
