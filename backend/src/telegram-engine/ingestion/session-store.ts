/**
 * Where Engine B's Telegram USER session lives, and the rules about touching
 * it.
 *
 * ## What this file is storing
 *
 * An MTProto session string is not a token that grants read access to one
 * channel. It is an authorization key: whoever holds it is logged in as that
 * Telegram account, can read its private messages, can post as it, and can
 * keep doing so until the session is revoked from the account's device list.
 * It deserves to be treated like a password file, and everything below
 * follows from that.
 *
 *  - It is written 0600, owner-only.
 *  - It lives in the runtime VOLUME, never in the image and never in the
 *    repository. `.gitignore` covers the path, and the file is created at
 *    authentication time on the host that will use it.
 *  - It is never logged, never returned by an API, never rendered on the
 *    dashboard and never included in a health response. The only thing any
 *    of those may say is whether a session EXISTS.
 *  - It is never shared with V1 or with any other deployment. Two processes
 *    using one session string fight over the same MTProto auth key and
 *    Telegram invalidates it, which would take ingestion down and require a
 *    fresh interactive login.
 *
 * ## Why a file rather than the database
 *
 * The database is backed up, replicated to wherever backups go, and readable
 * by every part of the application that holds a Prisma client. A credential
 * of this weight should be reachable by exactly one process, and a file in a
 * mounted volume is what makes that true.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultStateDir } from '../../xauusd-m1m5/state-store';

/**
 * The session path. Defaults into the same runtime directory the kill switch
 * uses — the volume every V2 container mounts at one path — so the session
 * survives container recreation, image rebuilds and a VPS reboot without an
 * operator re-entering a verification code.
 */
export function telegramSessionPath(): string {
  return process.env.TELEGRAM_INGEST_SESSION_PATH?.trim() || join(defaultStateDir(), 'telegram-ingest-session');
}

export interface StoredSession {
  readonly session: string;
  /** Set at authentication so the dashboard can show session age. */
  readonly authorizedAtMs: number;
  /** The account the session belongs to, for the operator's own records. */
  readonly accountLabel: string | null;
  /** The resolved source channel, verified on every message thereafter. */
  readonly sourceChannelId: string | null;
  readonly sourceChannelTitle: string | null;
}

export function hasStoredSession(): boolean {
  return existsSync(telegramSessionPath());
}

export function readStoredSession(): StoredSession | null {
  const path = telegramSessionPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSession>;
    if (typeof parsed.session !== 'string' || parsed.session.length === 0) return null;
    return {
      session: parsed.session,
      authorizedAtMs: typeof parsed.authorizedAtMs === 'number' ? parsed.authorizedAtMs : 0,
      accountLabel: parsed.accountLabel ?? null,
      sourceChannelId: parsed.sourceChannelId ?? null,
      sourceChannelTitle: parsed.sourceChannelTitle ?? null,
    };
  } catch {
    // A corrupt session file is not repaired and not partially trusted. The
    // operator re-authenticates, which is a two-minute interactive step, and
    // is far better than a process that half-believes it is logged in.
    return null;
  }
}

export function writeStoredSession(value: StoredSession): void {
  const path = telegramSessionPath();
  mkdirSync(dirname(path), { recursive: true });
  // The file is created with the restrictive mode rather than created and
  // then tightened: between those two steps a world-readable auth key exists
  // on disk, and that window is avoidable.
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode. The production host is Linux, where the mode
    // above applies; a development machine that cannot set it is not a reason
    // to fail, and the deploy path verifies the mode where it matters.
  }
}

/**
 * Records the resolved channel alongside the session, so a restart does not
 * have to re-resolve a username to know which chat id it trusts.
 */
export function updateStoredChannel(sourceChannelId: string, sourceChannelTitle: string): void {
  const existing = readStoredSession();
  if (!existing) throw new Error('cannot record a source channel before a session exists');
  writeStoredSession({ ...existing, sourceChannelId, sourceChannelTitle });
}

/**
 * What may safely be said about the session in a log line, a health response
 * or on the dashboard: that it exists, when it was created, and nothing else.
 * Deliberately returns no field that could carry key material.
 */
export interface SessionSummary {
  readonly present: boolean;
  readonly authorizedAtMs: number | null;
  readonly accountLabel: string | null;
  readonly sourceChannelId: string | null;
  readonly sourceChannelTitle: string | null;
  readonly permissionsOk: boolean | null;
}

export function summariseSession(): SessionSummary {
  const stored = readStoredSession();
  if (!stored) {
    return {
      present: false,
      authorizedAtMs: null,
      accountLabel: null,
      sourceChannelId: null,
      sourceChannelTitle: null,
      permissionsOk: null,
    };
  }
  return {
    present: true,
    authorizedAtMs: stored.authorizedAtMs || null,
    // A label the operator chose to store, never a phone number read from
    // Telegram. If it looks like a phone number it is masked.
    accountLabel: maskIfPhoneLike(stored.accountLabel),
    sourceChannelId: stored.sourceChannelId,
    sourceChannelTitle: stored.sourceChannelTitle,
    permissionsOk: sessionPermissionsOk(),
  };
}

/**
 * True when the session file is owner-only on a platform that has file modes.
 * Null where the concept does not apply, rather than a false "fine".
 */
export function sessionPermissionsOk(): boolean | null {
  const path = telegramSessionPath();
  if (!existsSync(path)) return null;
  if (process.platform === 'win32') return null;
  try {
    const mode = statSync(path).mode & 0o777;
    return mode === 0o600;
  } catch {
    return null;
  }
}

/**
 * Masks anything phone-number-shaped down to its last two digits.
 *
 * The operator's phone number is not a trading secret, but it is personal
 * data that has no business appearing on a dashboard that several people can
 * open, and masking it costs nothing.
 */
export function maskIfPhoneLike(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return value;
  return `${'*'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
}
