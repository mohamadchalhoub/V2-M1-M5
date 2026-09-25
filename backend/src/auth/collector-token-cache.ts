/**
 * Process-local cache of SUCCESSFUL collector-token verifications.
 *
 * Argon2id verification costs ~277 ms of CPU (m=64 MiB, t=3, p=4, four new
 * OS threads per call) and the collector authenticates several times per
 * second, which alone consumed ~1.5 cores. This cache lets a token that
 * already passed Argon2 skip it for up to 60 s. It never decides validity on
 * its own: the guard still re-reads the credential row on every cache hit
 * (not revoked, same scope, same account binding), so revocation, rotation
 * and deletion — which happen in separate CLI processes — take effect on the
 * very next request.
 *
 * Keys are SHA-256 digests of the presented token; the raw token is never
 * stored. Failed verifications are never cached. Size is bounded.
 */
import { createHash } from 'node:crypto';

export const COLLECTOR_TOKEN_CACHE_TTL_MS = 60_000;
export const COLLECTOR_TOKEN_CACHE_MAX_ENTRIES = 64;
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface VerifiedCredential {
  readonly credentialId: string;
  readonly accountId: string;
}

interface Entry extends VerifiedCredential {
  readonly expiresAtMs: number;
}

export function tokenDigest(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export class CollectorTokenCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly lastUsedWriteAtMs = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = COLLECTOR_TOKEN_CACHE_TTL_MS,
    private readonly maxEntries: number = COLLECTOR_TOKEN_CACHE_MAX_ENTRIES,
  ) {}

  get(digest: string, nowMs: number): VerifiedCredential | null {
    const e = this.entries.get(digest);
    if (!e) return null;
    if (e.expiresAtMs <= nowMs) {
      this.entries.delete(digest);
      return null;
    }
    return { credentialId: e.credentialId, accountId: e.accountId };
  }

  set(digest: string, value: VerifiedCredential, nowMs: number): void {
    this.entries.delete(digest);
    if (this.entries.size >= this.maxEntries) {
      for (const [k, e] of this.entries) if (e.expiresAtMs <= nowMs) this.entries.delete(k);
      while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    }
    this.entries.set(digest, { ...value, expiresAtMs: nowMs + this.ttlMs });
  }

  delete(digest: string): void {
    this.entries.delete(digest);
  }

  /** Drops every cached entry for a credential (revocation/rotation in this process). */
  invalidateCredential(credentialId: string): void {
    for (const [k, e] of this.entries) if (e.credentialId === credentialId) this.entries.delete(k);
    this.lastUsedWriteAtMs.delete(credentialId);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.lastUsedWriteAtMs.clear();
  }

  /** Concurrent misses for the same token share one verification; the slot is always released. */
  verifyOnce<T>(digest: string, verify: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(digest) as Promise<T> | undefined;
    if (pending) return pending;
    const p = verify().finally(() => this.inFlight.delete(digest));
    this.inFlight.set(digest, p);
    return p;
  }

  /** True at most once per interval per credential; claimed synchronously so concurrent requests cannot all write. */
  claimLastUsedWrite(credentialId: string, nowMs: number): boolean {
    const last = this.lastUsedWriteAtMs.get(credentialId);
    if (last !== undefined && nowMs - last < LAST_USED_WRITE_INTERVAL_MS) return false;
    if (last === undefined && this.lastUsedWriteAtMs.size >= this.maxEntries) this.lastUsedWriteAtMs.clear();
    this.lastUsedWriteAtMs.set(credentialId, nowMs);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  hasKey(key: string): boolean {
    return this.entries.has(key);
  }
}

/** One cache per API process, shared by every CollectorTokenGuard instance. */
export const collectorTokenCache = new CollectorTokenCache();
