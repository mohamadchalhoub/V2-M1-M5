export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface/50 px-6 py-12 text-center text-sm text-text-muted">
      {children}
    </div>
  );
}
