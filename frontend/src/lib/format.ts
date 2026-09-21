export function formatMoney(value: string | number, currency = 'USD'): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
}

export function formatNumber(value: string | number, digits = 2): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

// The dashboard has a single intended audience (the trader, based in
// Beirut), not per-viewer locale detection — every timestamp displays in
// Asia/Beirut regardless of the server's own system timezone (UTC on the
// production VPS), matching DAILY_ANALYSIS_TIMEZONE/HEARTBEAT_DIGEST_TIMEZONE
// on the backend side.
const DISPLAY_TIMEZONE = 'Asia/Beirut';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: DISPLAY_TIMEZONE,
  }).format(new Date(iso));
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  // A timestamp that's technically after "now" (real clock skew between
  // wherever it was recorded and this server, or the two clocks a few
  // hundred ms apart at render time) must never render as "-Ns ago" — that
  // reads as a real bug even when it's an unavoidable few-hundred-ms sliver.
  // Clamping to 0 here is a display-layer safety net; a diff large enough to
  // be a real data problem (not a sliver) still shows up as "0s ago"
  // instead of the true elapsed time, but that's a smaller lie than showing
  // negative seconds — the underlying data problem, if any, needs fixing at
  // the source, not by teaching this formatter to show "in the future".
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
