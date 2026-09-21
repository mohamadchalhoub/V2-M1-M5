"use client";

import { useActionState } from "react";
import { updateTrendBreakoutVolume, type VolumeUpdateState } from "./actions";
import type { TrendBreakoutInstrumentSettings } from "@/lib/api";

export function VolumeForm({ accountId, instrument }: { accountId: string; instrument: TrendBreakoutInstrumentSettings }) {
  const boundAction = updateTrendBreakoutVolume.bind(null, accountId, instrument.instrument);
  const [state, formAction, pending] = useActionState<VolumeUpdateState, FormData>(boundAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-2 mt-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-text-muted">
          Volume (lots)
          <input
            type="number"
            name="volumeLots"
            step="any"
            min="0"
            defaultValue={instrument.volume.volumeLots}
            className="ml-2 w-24 rounded border border-border bg-bg px-2 py-1 text-sm font-mono"
          />
        </label>
        <label className="text-xs text-text-muted">
          Your name/email
          <input
            type="text"
            name="changedBy"
            placeholder="alice@example.com"
            className="ml-2 w-44 rounded border border-border bg-bg px-2 py-1 text-sm"
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
        Applies to future entry requests only — never resizes an existing open position. This trade&apos;s volume is
        skipped (not resized) if it ever exceeds a risk/margin limit.
      </p>
      {state.error && <p className="text-sm text-down">{state.error}</p>}
      {state.warning && <p className="text-sm text-text-muted">⚠ {state.warning}</p>}
      {state.success && <p className="text-sm text-ok">Saved.</p>}
    </form>
  );
}
