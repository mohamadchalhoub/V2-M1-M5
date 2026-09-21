import Link from "next/link";
import type { HealthSnapshot } from "@/lib/api";
import { StatusPill } from "@/components/StatusPill";

const LABELS: Record<string, string> = {
  COLLECTOR: "Collector",
  MT5_TERMINAL: "MT5 Terminal",
  DATABASE: "Database",
  REDIS: "Redis",
  TELEGRAM: "Telegram",
  AI_PROVIDER: "AI Provider",
  XTB_IMPORT: "XTB Import",
  DATA_INTEGRITY: "Data Integrity",
};

export function HealthTileRow({ health, linkToDetail = true }: { health: HealthSnapshot; linkToDetail?: boolean }) {
  const entries = Object.entries(health) as [keyof HealthSnapshot, HealthSnapshot[keyof HealthSnapshot]][];

  const content = (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
      {entries.map(([component, status]) => (
        <div key={component} className="rounded-lg border border-border bg-surface px-3 py-2.5 flex flex-col gap-1.5">
          <span className="text-xs text-text-muted">{LABELS[component] ?? component}</span>
          <StatusPill status={status.status} />
        </div>
      ))}
    </div>
  );

  return linkToDetail ? (
    <Link href="/health" className="block hover:opacity-90 transition-opacity">
      {content}
    </Link>
  ) : (
    content
  );
}
