"use client";

import { useActionState } from "react";
import { setGoldStopNewEntries, type StopEntriesState } from "./actions";

export function StopEntriesForm({ currentlyActive }: { currentlyActive: boolean }) {
  const toggled = !currentlyActive;
  const boundAction = setGoldStopNewEntries.bind(null, toggled);
  const [state, formAction, pending] = useActionState<StopEntriesState, FormData>(boundAction, {});

  return (
    <form action={formAction} className="flex items-center gap-2 flex-wrap">
      <button
        type="submit"
        disabled={pending}
        className={`rounded-md border text-sm font-medium px-3 py-1.5 disabled:opacity-50 ${
          currentlyActive ? "border-ok text-ok" : "border-down text-down"
        }`}
      >
        {pending ? "Working…" : currentlyActive ? "Resume new entries" : "Stop new entries"}
      </button>
      <span className="text-xs text-text-muted">
        Currently: <strong>{currentlyActive ? "STOPPED" : "active"}</strong> — takes effect on the very next evaluation, no restart needed.
      </span>
      {state.error && <p className="text-sm text-down w-full">{state.error}</p>}
      {state.success && <p className="text-sm text-ok w-full">Done.</p>}
    </form>
  );
}
