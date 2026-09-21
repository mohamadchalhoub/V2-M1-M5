import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketauxClient, MarketauxRateLimitError } from '../../src/market-events/marketaux-client';

const API_TOKEN = 'test-marketaux-token-secret';

function mockMarketauxResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('MarketauxClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a successful response into MarketauxArticle[]', async () => {
    mockMarketauxResponse(200, {
      data: [
        { uuid: 'a1', title: 'ECB holds rates', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000000Z' },
      ],
    });
    const client = new MarketauxClient();
    const result = await client.getNews(API_TOKEN, ['EUR'], 3);
    expect(result).toEqual([
      { uuid: 'a1', title: 'ECB holds rates', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000000Z' },
    ]);
  });

  it('returns an empty array when the response has no data field', async () => {
    mockMarketauxResponse(200, {});
    const client = new MarketauxClient();
    const result = await client.getNews(API_TOKEN, ['EUR'], 3);
    expect(result).toEqual([]);
  });

  it('handles missing optional fields on an article without throwing', async () => {
    mockMarketauxResponse(200, {
      data: [{ uuid: 'a1', title: 'Headline only', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00Z' }],
    });
    const client = new MarketauxClient();
    const result = await client.getNews(API_TOKEN, ['EUR'], 3);
    expect(result[0].entities).toBeUndefined();
    expect(result[0].description).toBeUndefined();
  });

  it('throws MarketauxRateLimitError on a 429, never leaking the token', async () => {
    mockMarketauxResponse(429, { error: { message: `rate limited for token ${API_TOKEN}` } });
    const client = new MarketauxClient();
    await expect(client.getNews(API_TOKEN, ['EUR'], 3)).rejects.toThrow(MarketauxRateLimitError);
    try {
      await client.getNews(API_TOKEN, ['EUR'], 3);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(API_TOKEN);
    }
  });

  it('throws a generic error on a non-2xx, non-429 response, never leaking the token', async () => {
    mockMarketauxResponse(500, { error: { message: `internal error, token=${API_TOKEN}` } });
    const client = new MarketauxClient();
    try {
      await client.getNews(API_TOKEN, ['EUR'], 3);
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(MarketauxRateLimitError);
      expect(String(err)).toContain('500');
      expect(String(err)).not.toContain(API_TOKEN);
    }
  });

  it('throws on a network failure, never leaking the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error(`connection refused for token ${API_TOKEN}`);
    });
    const client = new MarketauxClient();
    try {
      await client.getNews(API_TOKEN, ['EUR'], 3);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(API_TOKEN);
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
    const client = new MarketauxClient();
    await expect(client.getNews(API_TOKEN, ['EUR'], 3, 50)).rejects.toThrow();
  });

  it('builds the search query by OR-ing configured currencies', async () => {
    const fetchSpy = mockMarketauxResponse(200, { data: [] });
    const client = new MarketauxClient();
    await client.getNews(API_TOKEN, ['EUR', 'USD'], 3);
    const calledUrl = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('search')).toBe('EUR OR USD');
    expect(calledUrl.searchParams.get('limit')).toBe('3');
  });
});
