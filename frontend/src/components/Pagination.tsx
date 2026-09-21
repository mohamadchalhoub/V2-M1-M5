import Link from "next/link";

export function Pagination({
  basePath,
  total,
  limit,
  offset,
}: {
  basePath: string;
  total: number;
  limit: number;
  offset: number;
}) {
  if (total <= limit) return null;

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-between mt-3 text-sm">
      <span className="text-text-muted">
        {showingFrom}–{showingTo} of {total}
      </span>
      <div className="flex gap-2">
        <Link
          href={`${basePath}?offset=${prevOffset}`}
          aria-disabled={!hasPrev}
          className={`px-3 py-1.5 rounded-md border border-border ${
            hasPrev ? "hover:bg-accent-soft hover:text-accent" : "opacity-40 pointer-events-none"
          }`}
        >
          Previous
        </Link>
        <Link
          href={`${basePath}?offset=${nextOffset}`}
          aria-disabled={!hasNext}
          className={`px-3 py-1.5 rounded-md border border-border ${
            hasNext ? "hover:bg-accent-soft hover:text-accent" : "opacity-40 pointer-events-none"
          }`}
        >
          Next
        </Link>
      </div>
    </div>
  );
}
