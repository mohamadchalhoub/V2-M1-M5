/**
 * Two process-local brakes on bearer-token authentication abuse. Both sit in
 * the API because Caddy 2.11's standard build has no rate-limit directive.
 *
 * AuthFailureLimiter counts FAILED authentications per client. Successful
 * requests are never counted, so a healthy collector or dashboard can never
 * trip it. Once a client reaches the limit, further attempts are refused with
 * 429 before any database lookup or Argon2 work, until its window ends.
 *
 * Argon2Gate caps how many Argon2 verifications run at once for tokens that
 * have never verified in this process. A flood of distinct well-formed tokens
 * from many addresses therefore queues behind a small number of slots and
 * then gets 429, instead of saturating the libuv thread pool that legitimate
 * authentication also needs. Tokens that verified recently bypass the gate
 * (see TokenAuthCache.isKnownGood).
 */
import type { FastifyRequest } from 'fastify';

export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 10 * 60_000;
export const AUTH_FAILURE_MAX_CLIENTS = 10_000;
export const ARGON2_MAX_CONCURRENT = 2;
export const ARGON2_MAX_QUEUED = 8;

interface Window {
  count: number;
  readonly endsAtMs: number;
}

export class AuthFailureLimiter {
  private readonly clients = new Map<string, Window>();

  constructor(
    private readonly limit: number = AUTH_FAILURE_LIMIT,
    private readonly windowMs: number = AUTH_FAILURE_WINDOW_MS,
    private readonly maxClients: number = AUTH_FAILURE_MAX_CLIENTS,
  ) {}

  /** Seconds until this client may authenticate again; 0 when it is not blocked. */
  retryAfterSeconds(key: string, nowMs: number): number {
    const w = this.clients.get(key);
    if (!w) return 0;
    if (w.endsAtMs <= nowMs) {
      this.clients.delete(key);
      return 0;
    }
    return w.count >= this.limit ? Math.ceil((w.endsAtMs - nowMs) / 1000) : 0;
  }

  recordFailure(key: string, nowMs: number): void {
    const w = this.clients.get(key);
    if (w && w.endsAtMs > nowMs) {
      w.count += 1;
      return;
    }
    this.clients.delete(key);
    this.makeRoom(nowMs);
    this.clients.set(key, { count: 1, endsAtMs: nowMs + this.windowMs });
  }

  private makeRoom(nowMs: number): void {
    if (this.clients.size < this.maxClients) return;
    for (const [k, w] of this.clients) if (w.endsAtMs <= nowMs) this.clients.delete(k);
    while (this.clients.size >= this.maxClients) this.clients.delete(this.clients.keys().next().value as string);
  }

  clear(): void {
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }
}

export class Argon2Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number = ARGON2_MAX_CONCURRENT,
    private readonly maxQueued: number = ARGON2_MAX_QUEUED,
  ) {}

  /** Runs the task when a slot is free; `{ ok: false }` when the queue is already full. */
  async run<T>(task: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.maxQueued) return { ok: false };
      // The releasing task hands its slot straight to us, so `active` is unchanged.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return { ok: true, value: await task() };
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }
}

/**
 * The client an authentication attempt is attributed to. Requests from the
 * Internet arrive through Caddy, which replaces any client-supplied
 * X-Forwarded-For with the real peer address (it trusts no upstream proxies),
 * so the first entry is the Internet client. Internal callers (the collector,
 * the dashboards) reach the API directly and are keyed by their own address.
 */
export function clientKey(request: FastifyRequest): string {
  const header = request.headers['x-forwarded-for'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
  return (first || request.ip || 'unknown').slice(0, 64);
}

export const authFailureLimiter = new AuthFailureLimiter();
export const argon2Gate = new Argon2Gate();
