const STYLES: Record<string, string> = {
  OK: "bg-ok-soft text-ok",
  SENT: "bg-ok-soft text-ok",
  COMPLETED: "bg-ok-soft text-ok",
  READY: "bg-ok-soft text-ok",
  ACTIVE: "bg-ok-soft text-ok",
  DEGRADED: "bg-warn-soft text-warn",
  PENDING: "bg-warn-soft text-warn",
  INACTIVE: "bg-border/60 text-text-muted",
  SKIPPED: "bg-border/60 text-text-muted",
  DOWN: "bg-down-soft text-down",
  FAILED: "bg-down-soft text-down",
  DEAD: "bg-down-soft text-down",
  WITHHELD: "bg-down-soft text-down",
};

export function StatusPill({ status }: { status: string | null | undefined }) {
  const label = status ?? "UNKNOWN";
  const style = STYLES[label] ?? "bg-border/60 text-text-muted";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide ${style}`}>
      {label}
    </span>
  );
}
