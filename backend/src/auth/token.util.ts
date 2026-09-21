import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

const COLLECTOR_TOKEN_PREFIX = 'tm_col_';
// Same 7-char length as the collector's own prefix, deliberately — the
// stored tokenPrefix is the first 8 characters of the full plaintext, so a
// 7-char literal prefix still leaves 1 real character of randomness in it
// (an 8-char literal would make every dashboard token's stored prefix
// identical, defeating its purpose as a fast, non-secret lookup key).
const DASHBOARD_TOKEN_PREFIX = 'tm_dsh_';

/** Generic — the only thing genuinely shared between collector and dashboard tokens is the random-bytes-plus-prefix shape; hashing/verification (below) already were. */
function generateToken(prefix: string): { plaintext: string; prefix: string } {
  const random = randomBytes(32).toString('base64url');
  const plaintext = `${prefix}${random}`;
  return { plaintext, prefix: plaintext.slice(0, 8) };
}

export function generateCollectorToken(): { plaintext: string; prefix: string } {
  return generateToken(COLLECTOR_TOKEN_PREFIX);
}

/** Dashboard-authenticated (production-readiness review — Option B): a second ApiCredential scope, own prefix so a leaked/logged token is immediately distinguishable by kind, never merged with the collector's own token shape. */
export function generateDashboardToken(): { plaintext: string; prefix: string } {
  return generateToken(DASHBOARD_TOKEN_PREFIX);
}

export function hashToken(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export function verifyToken(hash: string, plaintext: string): Promise<boolean> {
  return argon2.verify(hash, plaintext);
}
