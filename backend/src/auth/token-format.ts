/**
 * Cheap, secret-free shape check that runs before any database lookup or
 * Argon2 verification.
 *
 * token.util mints every token as a 7-character scope prefix followed by 32
 * random bytes in base64url (43 characters). A string of any other shape
 * cannot be a valid credential, so it is rejected without touching stored
 * hashes. The check looks only at the presented string, never at stored
 * material, so its timing says nothing about which tokens exist. A
 * well-formed but unknown token still goes through the full lookup and
 * Argon2 path and fails there.
 */
export type TokenScope = 'collector' | 'dashboard';

const SHAPES: Record<TokenScope, RegExp> = {
  collector: /^tm_col_[A-Za-z0-9_-]{43}$/,
  dashboard: /^tm_dsh_[A-Za-z0-9_-]{43}$/,
};

export const TOKEN_LENGTH = 50;

export function isWellFormedToken(scope: TokenScope, plaintext: string): boolean {
  return plaintext.length === TOKEN_LENGTH && SHAPES[scope].test(plaintext);
}
