import type { ReactNode } from "react";

export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-4 mb-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {right}
    </div>
  );
}
