import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { StatusPill } from "@/components/StatusPill";
import { EmptyState } from "@/components/EmptyState";

export default async function RulesPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const [accounts, rules] = await Promise.all([api.listAccounts(), api.rules(accountId)]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Rules"
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/rules" />}
      />

      <p className="text-sm text-text-muted -mt-4">
        Read-only. Rules are created and edited with{" "}
        <code className="font-mono bg-border/50 px-1.5 py-0.5 rounded">npm run manage-rules</code> in{" "}
        <code className="font-mono bg-border/50 px-1.5 py-0.5 rounded">backend/</code>.
      </p>

      {rules.length === 0 ? (
        <EmptyState>No rules configured for this account.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {rules.map((rule) => (
            <li key={rule.id} className="rounded-lg border border-border bg-surface px-4 py-3.5">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="font-medium text-sm">{rule.name}</p>
                  <p className="text-xs text-text-muted">{rule.ruleType}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill status={rule.state ?? "INACTIVE"} />
                  <StatusPill status={rule.enabled ? "ACTIVE" : "INACTIVE"} />
                </div>
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                {Object.entries(rule.parameters).map(([key, value]) => (
                  <div key={key} className="flex flex-col">
                    <dt className="text-text-muted">{key}</dt>
                    <dd className="font-mono">{JSON.stringify(value)}</dd>
                  </div>
                ))}
                <div className="flex flex-col">
                  <dt className="text-text-muted">cooldown</dt>
                  <dd className="font-mono">{rule.cooldownSeconds ?? "default"}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
