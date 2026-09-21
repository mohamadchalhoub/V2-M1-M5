import { describe, expect, it } from 'vitest';
import { CURATED_FRED_RELEASES, findCuratedRelease } from '../../src/market-events/curated-fred-releases';

describe('curated FRED releases allowlist', () => {
  it('has no duplicate release ids', () => {
    const ids = CURATED_FRED_RELEASES.map((r) => r.releaseId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has a non-empty title and at least one affected currency', () => {
    for (const release of CURATED_FRED_RELEASES) {
      expect(release.title.length).toBeGreaterThan(0);
      expect(release.affectedCurrencies.length).toBeGreaterThan(0);
    }
  });

  it('every typical release time is a plausible hour/minute', () => {
    for (const release of CURATED_FRED_RELEASES) {
      expect(release.typicalReleaseHourEt).toBeGreaterThanOrEqual(0);
      expect(release.typicalReleaseHourEt).toBeLessThan(24);
      expect(release.typicalReleaseMinuteEt).toBeGreaterThanOrEqual(0);
      expect(release.typicalReleaseMinuteEt).toBeLessThan(60);
    }
  });

  it('findCuratedRelease finds a known id (Employment Situation / NFP) and returns undefined for an uncurated one', () => {
    expect(findCuratedRelease(50)?.title).toContain('Employment Situation');
    expect(findCuratedRelease(197)).toBeUndefined(); // Dow Jones Averages — real FRED id, deliberately not curated
  });
});
