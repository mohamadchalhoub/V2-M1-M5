/**
 * Internal trust between Caddy and this dashboard.
 *
 * The dashboard has no login of its own: Caddy's basic_auth is the gate. On
 * the shared Docker network, though, any other container could reach this
 * server directly and skip that gate. Caddy therefore adds a secret header to
 * every request it forwards after basic_auth has passed (and overwrites any
 * value a client sent), and src/proxy.ts refuses every request that does not
 * carry it.
 *
 * The secret is read from DASHBOARD_PROXY_SECRET at runtime on the server. It
 * is deliberately not NEXT_PUBLIC_*, so it never reaches browser JavaScript.
 * A missing or short secret rejects everything: the check fails closed.
 */
export const PROXY_AUTH_HEADER = 'x-dashboard-proxy-auth';
export const MIN_PROXY_SECRET_LENGTH = 32;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time comparison of the presented header against the configured secret. */
export async function isTrustedProxyRequest(presented: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < MIN_PROXY_SECRET_LENGTH || !presented) return false;
  // Comparing fixed-length digests keeps the loop length independent of the input.
  const [a, b] = await Promise.all([sha256(presented), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
