"use client";

import { useActionState } from "react";
import { setStopNewEntries, setVolume, type ControlActionState } from "./actions";

export function StopEntriesControl({ currentlyActive, source }: { currentlyActive: boolean; source: string | null }) {
  const toggled = !currentlyActive;
  const boundAction = setStopNewEntries.bind(null, toggled);
  const [state, formAction, pending] = useActionState<ControlActionState, FormData>(
    async () => boundAction(),
    {},
  );

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
        Currently <strong>{currentlyActive ? "STOPPED" : "active"}</strong>
        {currentlyActive && source ? ` (${source})` : ""} — takes effect on the next evaluation, no restart needed.
        Protective closures, reconciliation and Friday liquidation are unaffected either way.
      </span>
      {state.error && <p className="text-sm text-down w-full">{state.error}</p>}
      {state.success && <p className="text-sm text-ok w-full">{state.success}</p>}
    </form>
  );
}

export function VolumeControl({
  current,
  min,
  max,
  step,
}: {
  current: number;
  min: number;
  max: number;
  step: number;
}) {
  const [state, formAction, pending] = useActionState<ControlActionState, FormData>(setVolume, {});

  return (
    <form action={formAction} className="flex items-end gap-2 flex-wrap">
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-text-muted">Volume (lots)</span>
        <input
          name="volumeLots"
          type="text"
          inputMode="decimal"
          defaultValue={String(current)}
          className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm font-mono w-32"
        />
      </label>
      <label className="flex flex-col gap-1 flex-1 min-w-48">
        <span className="text-xs uppercase tracking-wide text-text-muted">Note (for the audit trail)</span>
        <input
          name="note"
          type="text"
          placeholder="why this change"
          className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm w-full"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-accent text-accent text-sm font-medium px-3 py-1.5 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Set volume"}
      </button>
      <p className="text-xs text-text-muted w-full">
        Broker limits: min {min}, max {max}, step {step}. A value outside these is <strong>refused, not rounded</strong>,
        and a volume whose stop risk exceeds the per-trade cap is refused rather than reduced.
      </p>
      {state.error && <p className="text-sm text-down w-full">{state.error}</p>}
      {state.success && <p className="text-sm text-ok w-full">{state.success}</p>}
    </form>
  );
}
