"use client";

import { useActionState } from "react";
import { setM1M5Volume, type VolumeUpdateState } from "./actions";

export function VolumeForm({
  currentVolumeLots,
  minLots,
  maxLots,
  stepLots,
}: {
  currentVolumeLots: number | null;
  minLots: number | null;
  maxLots: number | null;
  stepLots: number | null;
}) {
  const [state, formAction, pending] = useActionState<VolumeUpdateState, FormData>(setM1M5Volume, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-text-muted">
          Volume (lots)
          <input
            type="number"
            name="volumeLots"
            step={stepLots && Number.isFinite(stepLots) ? stepLots : "any"}
            min={minLots !== null && Number.isFinite(minLots) ? minLots : 0}
            max={maxLots !== null && Number.isFinite(maxLots) ? maxLots : undefined}
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
        Broker-validated (min {minLots ?? "—"} / max {maxLots ?? "—"} / step {stepLots ?? "—"}) and audited. Live
        from the next evaluation onward — never resizes an already-open position or a decision already queued.
      </p>
      {state.error && <p className="text-sm text-down">{state.error}</p>}
      {state.success && <p className="text-sm text-ok">Saved.</p>}
    </form>
  );
}
