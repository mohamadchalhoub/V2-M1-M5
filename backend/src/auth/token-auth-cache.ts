/**
 * Process-local cache of SUCCESSFUL bearer-token verifications, one instance
 * per credential scope (collector, dashboard).
 *
 * Argon2id verification costs ~277 ms of CPU (m=64 MiB, t=3, p=4, four new
 * OS threads per call) and the collector authenticates several times per
 * second, which alone consumed ~1.5 cores. This cache lets a token that
 * already passed Argon2 skip it for up to 60 s. It never decides validity on
 * its own: the guard still re-reads the credential row on every cache hit
 * (not revoked, same scope, same account binding), so revocation, rotation
 * and deletion — which happen in separate CLI processes — take effect on the
 * very next request. `invalidateCredential` covers the same operations if
 * they are ever performed inside the API process. With more than one API
 * process each keeps its own cache; the per-hit row re-read is what keeps
 * them all correct, so no shared invalidation channel is needed.
 *
 * Keys are SHA-256 digests of the presented token; the raw token is never
 * stored. Failed verifications are never cached. Every map is bounded.
 */
import { createHash } from 'node:crypto';

export const TOKEN_CACHE_TTL_MS = 60_000;
export const TOKEN_CACHE_MAX_ENTRIES = 64;
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;
/** How long a digest that once verified keeps priority past the Argon2 gate. */
export const KNOWN_GOOD_TTL_MS = 24 * 60 * 60_000;

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

export class TokenAuthCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly lastUsedWriteAtMs = new Map<string, number>();
  private readonly knownGood = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = TOKEN_CACHE_TTL_MS,
    private readonly maxEntries: number = TOKEN_CACHE_MAX_ENTRIES,
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
    this.rememberKnownGood(digest, nowMs);
  }

  delete(digest: string): void {
    this.entries.delete(digest);
    this.knownGood.delete(digest);
  }

  /** Drops every cached entry for a credential (revocation/rotation in this process). */
  invalidateCredential(credentialId: string): void {
    for (const [k, e] of this.entries) {
      if (e.credentialId === credentialId) {
        this.entries.delete(k);
        this.knownGood.delete(k);
      }
    }
    this.lastUsedWriteAtMs.delete(credentialId);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.lastUsedWriteAtMs.clear();
    this.knownGood.clear();
  }

  /**
   * True when this digest verified successfully in the last 24 h. Used ONLY to
   * let a legitimate client's periodic re-verification skip the queue in front
   * of Argon2 — never to decide that a token is valid.
   */
  isKnownGood(digest: string, nowMs: number): boolean {
    const until = this.knownGood.get(digest);
    if (until === undefined) return false;
    if (until <= nowMs) {
      this.knownGood.delete(digest);
      return false;
    }
    return true;
  }

  private rememberKnownGood(digest: string, nowMs: number): void {
    this.knownGood.delete(digest);
    while (this.knownGood.size >= this.maxEntries) this.knownGood.delete(this.knownGood.keys().next().value as string);
    this.knownGood.set(digest, nowMs + KNOWN_GOOD_TTL_MS);
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

/** One cache per scope per API process, shared by every guard instance. */
export const collectorTokenCache = new TokenAuthCache();
export const dashboardTokenCache = new TokenAuthCache();
