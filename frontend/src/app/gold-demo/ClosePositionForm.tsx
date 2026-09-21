"use client";

import { useActionState } from "react";
import { requestGoldClosePosition, type ClosePositionState } from "./actions";

/**
 * Queues a real close request the collector polls for and executes via
 * MT5 (executor.py's close_position) on its next cycle — NOT instant, and
 * only reported "closed" once the broker actually confirms it (see
 * GoldExecutionController.postCloseResult). The confirm dialog says so.
 */
export function ClosePositionForm({ positionId }: { positionId: string }) {
  const boundAction = requestGoldClosePosition.bind(null, positionId);
  const [state, formAction, pending] = useActionState<ClosePositionState, FormData>(boundAction, {});

  const confirmed = () => window.confirm(`Request closing position ${positionId}? This queues a REAL close for the collector's next poll cycle — it is not instant, and this dashboard will only show it as closed once the broker confirms.`);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirmed()) e.preventDefault();
      }}
    >
      <button type="submit" disabled={pending} className="rounded border border-down text-down text-xs font-medium px-2 py-1 disabled:opacity-50">
        {pending ? "Queuing…" : "Request close (executes on next collector poll)"}
      </button>
      {state.error && <p className="text-xs text-down mt-1">{state.error}</p>}
      {state.success && <p className="text-xs text-ok mt-1">{state.note ?? "Recorded."}</p>}
    </form>
  );
}
