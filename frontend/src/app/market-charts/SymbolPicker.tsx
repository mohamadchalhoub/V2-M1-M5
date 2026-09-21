"use client";

import { useRouter } from "next/navigation";

const SYMBOLS = ["EURUSD", "XAUUSD"] as const;

// URL-driven selection, same pattern as components/AccountSwitcher.tsx:
// changing the select navigates to a new `/market-charts` URL and the page
// re-fetches server-side. Preserves the current timeframe/from/to.
export function SymbolPicker({
  currentSymbol,
  timeframe,
  from,
  to,
}: {
  currentSymbol: string;
  timeframe: string;
  from?: string;
  to?: string;
}) {
  const router = useRouter();

  function navigate(symbol: string) {
    const qs = new URLSearchParams({ symbol, timeframe });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    router.push(`/market-charts?${qs.toString()}`);
  }

  return (
    <select
      value={currentSymbol}
      onChange={(e) => navigate(e.target.value)}
      className="text-sm bg-surface border border-border rounded-md px-2.5 py-1.5 text-text"
    >
      {SYMBOLS.map((symbol) => (
        <option key={symbol} value={symbol}>
          {symbol}
        </option>
      ))}
    </select>
  );
}
