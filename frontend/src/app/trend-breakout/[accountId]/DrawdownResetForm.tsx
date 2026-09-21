"use client";

import { useActionState } from "react";
import { resetTrendBreakoutDrawdown, type DrawdownResetState } from "./actions";

export function DrawdownResetForm({ accountId }: { accountId: string }) {
  const boundAction = resetTrendBreakoutDrawdown.bind(null, accountId);
  const [state, formAction, pending] = useActionState<DrawdownResetState, FormData>(boundAction, {});

  return (
    <form action={formAction} className="flex items-center gap-2 flex-wrap">
      <input
        type="text"
        name="resetBy"
        placeholder="your name/email"
        className="w-44 rounded border border-border bg-bg px-2 py-1 text-sm"
      />
      <button type="submit" disabled={pending} className="rounded-md border border-border text-sm font-medium px-3 py-1.5 disabled:opacity-50">
        {pending ? "Resetting…" : "Explicitly reset drawdown block"}
      </button>
      {state.error && <p className="text-sm text-down">{state.error}</p>}
      {state.success && <p className="text-sm text-ok">Reset.</p>}
    </form>
  );
}
