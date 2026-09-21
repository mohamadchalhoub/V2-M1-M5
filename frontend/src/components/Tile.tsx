export function Tile({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "ok" | "warn" | "down" }) {
  const toneClass = {
    neutral: "text-text",
    ok: "text-ok",
    warn: "text-warn",
    down: "text-down",
  }[tone];

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-text-muted mb-1">{label}</p>
      <p className={`text-lg font-semibold font-mono ${toneClass}`}>{value}</p>
    </div>
  );
}
