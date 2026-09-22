/**
 * Credential containment, asserted rather than remembered.
 *
 * Engine B holds material that is far more dangerous than a trading
 * parameter: an MTProto session string is an authorization key equivalent to
 * being logged in as the operator's Telegram account, and the API hash
 * identifies the application that key belongs to. Neither may reach a log
 * line, an API response, the dashboard or an image layer.
 *
 * "We were careful" is not a guarantee. These tests are, because they fail if
 * someone later widens a summary or adds a convenient debug field.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summariseSession, maskIfPhoneLike } from '../../src/telegram-engine/ingestion/session-store';

const SRC = join(__dirname, '../../src/telegram-engine');

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

describe('the session summary cannot carry key material', () => {
  it('exposes only presence and identity fields', () => {
    const summary = summariseSession();
    // Whatever the machine's state, the SHAPE is fixed and contains no
    // session field. This is the object every health and dashboard response
    // is built from.
    expect(Object.keys(summary).sort()).toEqual([
      'accountLabel',
      'authorizedAtMs',
      'permissionsOk',
      'present',
      'sourceChannelId',
      'sourceChannelTitle',
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/session/i);
  });

  it('masks a phone-number-shaped label', () => {
    expect(maskIfPhoneLike('+96170123456')).not.toContain('70123456');
  });
});

describe('no surface returns the session or the API hash', () => {
  it('the dashboard controller never reads the session string', () => {
    const source = read('dashboard.controller.ts');
    expect(source).not.toMatch(/readStoredSession/);
    expect(source).not.toMatch(/apiHash|API_HASH/);
    // It may only use the redacted summary.
    expect(source).toMatch(/summariseSession/);
  });

  it('the ingestion service reports health through the redacted summary only', () => {
    const source = read('ingestion/ingestion.service.ts');
    expect(source).not.toMatch(/readStoredSession/);
    expect(source).not.toMatch(/apiHash|API_HASH/);
  });

  it('the collector-facing controller touches neither', () => {
    const source = read('execution.controller.ts');
    expect(source).not.toMatch(/session|apiHash|API_HASH/i);
  });

  it('the API hash is never interpolated into a message', () => {
    const source = read('ingestion/gramjs-client.ts');
    // It may be read from the environment and handed to the client, and it
    // may be reported as MISSING by name — but never printed by value.
    expect(source).not.toMatch(/\$\{apiHash\}/);
    expect(source).not.toMatch(/log\([^)]*apiHash/);
  });

  it('the auth script never echoes the hash or the session it writes', () => {
    const source = readFileSync(join(__dirname, '../../scripts/telegram-auth.ts'), 'utf8');
    expect(source).not.toMatch(/console\.log\([^)]*apiHash/);
    expect(source).not.toMatch(/console\.log\([^)]*session\.save\(\)/);
    // It does print the PATH, which is safe and is what an operator needs.
    expect(source).toMatch(/telegramSessionPath\(\)/);
  });

  it('the 2FA password is read without echo and never from a pipe', () => {
    const source = readFileSync(join(__dirname, '../../scripts/telegram-auth.ts'), 'utf8');
    expect(source).toMatch(/askSecret\('Two-factor password/);
    // A secret typed at a terminal, never accepted from stdin redirection
    // where it would come from a file or a shell history.
    expect(source).toMatch(/isTTY/);
  });
});

describe('the session file is written restrictively', () => {
  it('is created 0600 rather than created and then tightened', () => {
    const source = read('ingestion/session-store.ts');
    // The mode is in the write itself: a create-then-chmod leaves a window in
    // which a world-readable auth key exists on disk.
    expect(source).toMatch(/mode:\s*0o600/);
  });

  it('lives in the runtime state directory, not the repository', () => {
    const source = read('ingestion/session-store.ts');
    expect(source).toMatch(/defaultStateDir\(\)/);
  });
});

describe('no credential is hard-coded anywhere in the engine', () => {
  it('contains no 32-character hex literal that could be an API hash', () => {
    const files = [
      'ingestion/gramjs-client.ts',
      'ingestion/session-store.ts',
      'ingestion/ingestion.service.ts',
      'ingestion/channel-guard.ts',
      'dashboard.controller.ts',
      'execution.controller.ts',
      'spec.ts',
      'safety-constants.ts',
    ];
    for (const file of files) {
      const source = read(file);
      // A Telegram API hash is 32 lowercase hex characters. Nothing in this
      // engine should contain a literal of that shape.
      expect(source, `${file} contains something shaped like an API hash`).not.toMatch(/['"`][0-9a-f]{32}['"`]/);
    }
  });
});
