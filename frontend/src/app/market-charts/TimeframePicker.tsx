"use client";

import { useRouter } from "next/navigation";

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;

// Same URL-driven-navigation pattern as SymbolPicker/AccountSwitcher.
// Deliberately does NOT preserve from/to across a timeframe change unless
// the user already had an explicit range set — each timeframe has a very
// different sensible default window (see DEFAULT_LOOKBACK_DAYS in page.tsx),
// so dropping an implicit default lets the new timeframe pick its own.
export function TimeframePicker({
  currentTimeframe,
  symbol,
  from,
  to,
}: {
  currentTimeframe: string;
  symbol: string;
  from?: string;
  to?: string;
}) {
  const router = useRouter();

  function navigate(timeframe: string) {
    const qs = new URLSearchParams({ symbol, timeframe });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    router.push(`/market-charts?${qs.toString()}`);
  }

  return (
    <select
      value={currentTimeframe}
      onChange={(e) => navigate(e.target.value)}
      className="text-sm bg-surface border border-border rounded-md px-2.5 py-1.5 text-text"
    >
      {TIMEFRAMES.map((timeframe) => (
        <option key={timeframe} value={timeframe}>
          {timeframe}
        </option>
      ))}
    </select>
  );
}
