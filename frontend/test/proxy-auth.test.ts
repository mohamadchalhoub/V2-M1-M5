// Run with: node --test test/proxy-auth.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN_PROXY_SECRET_LENGTH, isTrustedProxyRequest } from '../src/lib/proxy-auth.ts';

const secret = 's'.repeat(MIN_PROXY_SECRET_LENGTH + 16);

test('the Caddy-supplied secret is accepted', async () => {
  assert.equal(await isTrustedProxyRequest(secret, secret), true);
});

test('a request without the header is rejected', async () => {
  assert.equal(await isTrustedProxyRequest(null, secret), false);
  assert.equal(await isTrustedProxyRequest('', secret), false);
});

test('a wrong secret is rejected, including prefixes and extensions of the real one', async () => {
  assert.equal(await isTrustedProxyRequest('x'.repeat(secret.length), secret), false);
  assert.equal(await isTrustedProxyRequest(secret.slice(0, -1), secret), false);
  assert.equal(await isTrustedProxyRequest(secret + 's', secret), false);
});

test('an absent or short configured secret rejects everything (fails closed)', async () => {
  assert.equal(await isTrustedProxyRequest(secret, undefined), false);
  assert.equal(await isTrustedProxyRequest('', ''), false);
  const short = 's'.repeat(MIN_PROXY_SECRET_LENGTH - 1);
  assert.equal(await isTrustedProxyRequest(short, short), false);
});
