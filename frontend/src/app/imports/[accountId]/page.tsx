import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { StatusPill } from "@/components/StatusPill";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";
import { UploadForm } from "./UploadForm";

export default async function ImportsPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const [accounts, account, batches] = await Promise.all([
    api.listAccounts(),
    api.getAccount(accountId),
    api.importBatches(accountId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="XTB imports"
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/imports" />}
      />

      {account.platform === "XTB" ? (
        <UploadForm accountId={accountId} />
      ) : (
        <EmptyState>
          {account.displayName ?? account.externalAccountId} is an MT5 account — its trades arrive live from the
          collector. CSV import is only for XTB accounts, which have no live feed yet.
        </EmptyState>
      )}

      {batches.length === 0 ? (
        <EmptyState>No import batches for this account yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
              <tr>
                <th className="px-4 py-2.5">Uploaded</th>
                <th className="px-4 py-2.5">File</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Imported</th>
                <th className="px-4 py-2.5">Skipped</th>
                <th className="px-4 py-2.5">Error</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{formatDateTime(batch.createdAt)}</td>
                  <td className="px-4 py-2.5">{batch.fileName ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={batch.status} />
                  </td>
                  <td className="px-4 py-2.5 font-mono">
                    {batch.rowsImported} / {batch.rowsTotal}
                  </td>
                  <td className="px-4 py-2.5 font-mono">{batch.rowsSkipped}</td>
                  <td className="px-4 py-2.5 text-down text-xs max-w-xs truncate">{batch.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
