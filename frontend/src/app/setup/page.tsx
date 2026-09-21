import { EmptyState } from "@/components/EmptyState";

export default function SetupPage() {
  return (
    <EmptyState>
      <p className="text-text font-medium mb-1">No trading accounts yet</p>
      <p>
        Run <code className="font-mono bg-border/50 px-1.5 py-0.5 rounded">npm run bootstrap</code> in{" "}
        <code className="font-mono bg-border/50 px-1.5 py-0.5 rounded">backend/</code> to create the first user and
        account, then reload this page.
      </p>
    </EmptyState>
  );
}
