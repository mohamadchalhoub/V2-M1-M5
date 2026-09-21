import { afterEach, describe, expect, it, vi } from 'vitest';
import { FredClient } from '../../src/market-events/fred-client';

const API_KEY = 'test-fred-key-secret';

function mockFredResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('FredClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps release_dates into the FredReleaseDate shape', async () => {
    mockFredResponse(200, {
      count: 2,
      release_dates: [
        { release_id: 50, release_name: 'Employment Situation', date: '2026-10-02' },
        { release_id: 10, release_name: 'Consumer Price Index', date: '2026-10-14' },
      ],
    });
    const client = new FredClient();
    const result = await client.getUpcomingReleaseDates(API_KEY, '2026-10-01', '2026-10-31');
    expect(result).toEqual([
      { releaseId: 50, releaseName: 'Employment Situation', date: '2026-10-02' },
      { releaseId: 10, releaseName: 'Consumer Price Index', date: '2026-10-14' },
    ]);
  });

  it('paginates when the result count exceeds one page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ release_id: i, release_name: `r${i}`, date: '2026-10-01' }));
    const page2 = [{ release_id: 9999, release_name: 'last one', date: '2026-10-02' }];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 1001, release_dates: page1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 1001, release_dates: page2 }), { status: 200 }));

    const client = new FredClient();
    const result = await client.getUpcomingReleaseDates(API_KEY, '2026-10-01', '2026-10-31');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1001);
    expect(result[1000].releaseId).toBe(9999);
  });

  it('throws on a non-2xx response and never leaks the API key', async () => {
    mockFredResponse(400, { error_message: `Bad Request. Variable api_key is not ${API_KEY}` });
    const client = new FredClient();
    try {
      await client.getUpcomingReleaseDates(API_KEY, '2026-10-01', '2026-10-31');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain('400');
      expect(String(err)).not.toContain(API_KEY);
    }
  });

  it('never leaks the API key in a network-error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error(`connection refused for key ${API_KEY}`);
    });
    const client = new FredClient();
    try {
      await client.getUpcomingReleaseDates(API_KEY, '2026-10-01', '2026-10-31');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(API_KEY);
    }
  });
});
