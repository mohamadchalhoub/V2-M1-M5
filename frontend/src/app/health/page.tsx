import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime, formatRelative } from "@/lib/format";

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

// See page.tsx's comment — same latent build-time prerender bug, same fix.
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const [health, incidents] = await Promise.all([api.health(), api.healthIncidents()]);
  const components = Object.entries(health);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="System health" />

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Components</h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
              <tr>
                <th className="px-4 py-2.5">Component</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Last checked</th>
                <th className="px-4 py-2.5">Detail</th>
              </tr>
            </thead>
            <tbody>
              {components.map(([component, status]) => (
                <tr key={component} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-2.5 font-medium">{LABELS[component] ?? component}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={status.status} />
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">{formatRelative(status.checkedAt)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-muted max-w-md truncate">
                    {status.detail ? JSON.stringify(status.detail) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Incident history</h2>
        {incidents.length === 0 ? (
          <EmptyState>No incidents recorded — every component has stayed at its initial status.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
                <tr>
                  <th className="px-4 py-2.5">Component</th>
                  <th className="px-4 py-2.5">Change</th>
                  <th className="px-4 py-2.5">Opened</th>
                  <th className="px-4 py-2.5">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr key={incident.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-medium">{LABELS[incident.component] ?? incident.component}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusPill status={incident.statusFrom} />
                        <span className="text-text-muted">→</span>
                        <StatusPill status={incident.statusTo} />
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">{formatDateTime(incident.openedAt)}</td>
                    <td className="px-4 py-2.5 text-text-muted">
                      {incident.resolvedAt ? formatDateTime(incident.resolvedAt) : "Ongoing"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
