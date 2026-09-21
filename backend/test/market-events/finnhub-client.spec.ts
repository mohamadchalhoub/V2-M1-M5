import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinnhubClient } from '../../src/market-events/finnhub-client';

const API_KEY = 'test-finnhub-key-secret';

function mockFinnhubResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('FinnhubClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a successful response into FinnhubArticle[]', async () => {
    mockFinnhubResponse(200, [
      { category: 'forex', datetime: 1788856296, headline: 'ECB holds rates', id: 1, related: '', source: 'Forexlive', summary: 'summary text', url: 'https://example.com/a1' },
    ]);
    const client = new FinnhubClient();
    const result = await client.getForexNews(API_KEY);
    expect(result).toEqual([
      { category: 'forex', datetime: 1788856296, headline: 'ECB holds rates', id: 1, related: '', source: 'Forexlive', summary: 'summary text', url: 'https://example.com/a1' },
    ]);
  });

  it('requests the forex category specifically', async () => {
    const fetchSpy = mockFinnhubResponse(200, []);
    const client = new FinnhubClient();
    await client.getForexNews(API_KEY);
    const calledUrl = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('category')).toBe('forex');
  });

  it('throws a clear error on a 429, never leaking the key', async () => {
    mockFinnhubResponse(429, { error: `rate limited for key ${API_KEY}` });
    const client = new FinnhubClient();
    try {
      await client.getForexNews(API_KEY);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain('429');
      expect(String(err)).not.toContain(API_KEY);
    }
  });

  it('throws on a non-2xx response, never leaking the key', async () => {
    mockFinnhubResponse(500, { error: `internal error, key=${API_KEY}` });
    const client = new FinnhubClient();
    try {
      await client.getForexNews(API_KEY);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain('500');
      expect(String(err)).not.toContain(API_KEY);
    }
  });

  it('throws on a network failure, never leaking the key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error(`connection refused for key ${API_KEY}`);
    });
    const client = new FinnhubClient();
    try {
      await client.getForexNews(API_KEY);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(API_KEY);
    }
  });

  it('times out rather than hanging indefinitely when the request never resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit)?.signal;
          signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }),
    );
    const client = new FinnhubClient();
    await expect(client.getForexNews(API_KEY, 50)).rejects.toThrow();
  });
});
