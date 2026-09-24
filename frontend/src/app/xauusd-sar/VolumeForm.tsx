"use client";

import { useActionState } from "react";
import { setSarVolume, type VolumeUpdateState } from "./actions";

export function VolumeForm({ currentVolumeLots }: { currentVolumeLots: number | null }) {
  const [state, formAction, pending] = useActionState<VolumeUpdateState, FormData>(setSarVolume, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-text-muted">
          Volume (lots)
          <input
            type="number"
            name="volumeLots"
            step="any"
            min={0}
            defaultValue={currentVolumeLots ?? undefined}
            className="ml-2 w-24 rounded border border-border bg-bg px-2 py-1 text-sm font-mono"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent text-white text-sm font-medium px-3 py-1.5 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-xs text-text-muted">
        Broker-validated and audited. Never resizes an already-open position — a new volume applies from the next
        session or reversal onward.
      </p>
      {state.error && <p className="text-sm text-down">{state.error}</p>}
      {state.success && <p className="text-sm text-ok">Saved.</p>}
    </form>
  );
}
