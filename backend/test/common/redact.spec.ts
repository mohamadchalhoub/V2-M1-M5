import { describe, expect, it } from 'vitest';
import { redactToken } from '../../src/common/redact';

describe('redactToken', () => {
  it('strips every occurrence of the token from a string', () => {
    const token = 'abc123secret';
    const text = `error at https://api.telegram.org/bot${token}/sendMessage and again ${token}`;
    const redacted = redactToken(text, token);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('[REDACTED]');
  });

  it('is a no-op for an empty token', () => {
    expect(redactToken('hello world', '')).toBe('hello world');
  });
});
