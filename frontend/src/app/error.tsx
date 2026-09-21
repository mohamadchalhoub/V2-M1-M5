"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-lg border border-down/40 bg-down-soft px-6 py-8 text-center">
      <p className="font-medium text-down mb-1">Something went wrong loading this page</p>
      <p className="text-sm text-text-muted mb-4">{error.message || "The API may be unreachable."}</p>
      <button onClick={() => reset()} className="rounded-md bg-accent text-white text-sm font-medium px-4 py-1.5">
        Retry
      </button>
    </div>
  );
}
