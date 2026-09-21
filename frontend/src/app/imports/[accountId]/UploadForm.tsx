"use client";

import { useActionState } from "react";
import { uploadXtbCsv, type UploadState } from "./actions";

export function UploadForm({ accountId }: { accountId: string }) {
  const boundAction = uploadXtbCsv.bind(null, accountId);
  const [state, formAction, pending] = useActionState<UploadState, FormData>(boundAction, {});

  return (
    <form action={formAction} className="rounded-lg border border-border bg-surface px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:text-accent file:px-3 file:py-1.5 file:text-sm file:font-medium"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent text-white text-sm font-medium px-4 py-1.5 disabled:opacity-50"
        >
          {pending ? "Importing…" : "Import CSV"}
        </button>
      </div>
      {state.error && <p className="text-sm text-down">{state.error}</p>}
      {state.success && <p className="text-sm text-ok">Import completed.</p>}
    </form>
  );
}
