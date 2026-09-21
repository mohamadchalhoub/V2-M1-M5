"use client";

import { useRouter } from "next/navigation";
import type { Account } from "@/lib/api";

export function AccountSwitcher({
  accounts,
  currentAccountId,
  basePath,
}: {
  accounts: Account[];
  currentAccountId: string;
  basePath: string; // e.g. "/dashboard" — the switcher navigates to `${basePath}/${accountId}`
}) {
  const router = useRouter();

  if (accounts.length <= 1) {
    const only = accounts[0];
    return only ? (
      <span className="text-sm text-text-muted">
        {only.displayName ?? only.externalAccountId} · {only.platform}
      </span>
    ) : null;
  }

  return (
    <select
      value={currentAccountId}
      onChange={(e) => router.push(`${basePath}/${e.target.value}`)}
      className="text-sm bg-surface border border-border rounded-md px-2.5 py-1.5 text-text"
    >
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {(account.displayName ?? account.externalAccountId) + " · " + account.platform}
        </option>
      ))}
    </select>
  );
}
