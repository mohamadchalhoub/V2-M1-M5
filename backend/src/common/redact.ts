/**
 * Shared by every module holding a secret that must never reach a log line,
 * an Error message, or a persisted `lastError` — `telegram` (bot token) and
 * `ai` (provider API key) both use this (AI_INTEGRATION_SPEC.md §9: "the
 * one cross-module refactor this phase needs").
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('[REDACTED]');
}
