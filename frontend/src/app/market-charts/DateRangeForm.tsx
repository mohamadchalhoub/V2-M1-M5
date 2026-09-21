"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

// datetime-local inputs need "YYYY-MM-DDTHH:mm" (no seconds, no timezone
// suffix) — trim a full ISO string down to that for the input's value; the
// round trip back to a real ISO string happens on submit via `new
// Date(value).toISOString()`.
function toInputValue(iso: string): string {
  return iso.slice(0, 16);
}

// Same URL-driven-navigation pattern as SymbolPicker/TimeframePicker: submit
// pushes a new `/market-charts` URL carrying explicit from/to, and the page
// re-fetches server-side with that exact range.
export function DateRangeForm({
  symbol,
  timeframe,
  from,
  to,
}: {
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const [fromValue, setFromValue] = useState(toInputValue(from));
  const [toValue, setToValue] = useState(toInputValue(to));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const qs = new URLSearchParams({ symbol, timeframe });
    if (fromValue) qs.set("from", new Date(fromValue).toISOString());
    if (toValue) qs.set("to", new Date(toValue).toISOString());
    router.push(`/market-charts?${qs.toString()}`);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface px-4 py-3"
    >
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        From
        <input
          type="datetime-local"
          value={fromValue}
          onChange={(e) => setFromValue(e.target.value)}
          className="text-sm bg-surface border border-border rounded-md px-2.5 py-1.5 text-text"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        To
        <input
          type="datetime-local"
          value={toValue}
          onChange={(e) => setToValue(e.target.value)}
          className="text-sm bg-surface border border-border rounded-md px-2.5 py-1.5 text-text"
        />
      </label>
      <button
        type="submit"
        className="text-sm bg-accent-soft text-accent font-medium rounded-md px-3 py-1.5 hover:opacity-80"
      >
        Apply range
      </button>
    </form>
  );
}
