const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface Pagination {
  take: number;
  skip: number;
}

// Shared by every read-only list endpoint (dashboard, Phase 9) — clamps
// caller-supplied limit/offset rather than trusting raw query strings, since
// these endpoints have no auth yet and sit behind only a CORS allowlist.
export function parsePagination(limit?: string, offset?: string): Pagination {
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  const take = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const skip = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  return { take, skip };
}
