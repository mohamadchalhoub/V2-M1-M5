import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { StatusPill } from "@/components/StatusPill";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";
import { formatDateTime } from "@/lib/format";

const LIMIT = 25;

export default async function AlertsPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const { accountId } = await params;
  const { offset: offsetParam } = await searchParams;
  const offset = Number(offsetParam) || 0;

  const [accounts, page] = await Promise.all([api.listAccounts(), api.alerts(accountId, { limit: LIMIT, offset })]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Alert history"
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/alerts" />}
      />

      {page.alerts.length === 0 ? (
        <EmptyState>No alerts have fired for this account.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
              <tr>
                <th className="px-4 py-2.5">Triggered</th>
                <th className="px-4 py-2.5">Rule</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Delivery</th>
                <th className="px-4 py-2.5">AI narrative</th>
              </tr>
            </thead>
            <tbody>
              {page.alerts.map((alert) => (
                <tr key={alert.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{formatDateTime(alert.triggeredAt)}</td>
                  <td className="px-4 py-2.5 font-medium">{alert.rule.name}</td>
                  <td className="px-4 py-2.5 text-text-muted">{alert.rule.ruleType}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={alert.delivery?.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    {alert.aiAnalysis ? (
                      <StatusPill status={alert.aiAnalysis.safetyFlagged ? "WITHHELD" : alert.aiAnalysis.status} />
                    ) : (
                      <span className="text-text-muted text-xs">not first-of-episode</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination basePath={`/alerts/${accountId}`} total={page.total} limit={page.limit} offset={page.offset} />
    </div>
  );
}
