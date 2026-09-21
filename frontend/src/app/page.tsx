import { redirect } from "next/navigation";
import { api } from "@/lib/api";

// Without this, Next.js attempts to prerender "/" at build time to see
// whether it CAN be static — before that attempt ever reaches the
// `cache: 'no-store'` fetch in lib/api.ts that would otherwise signal
// "dynamic," it hits apiFetch's own guard clause for a missing
// DASHBOARD_API_TOKEN (correctly unset at build time — it's a runtime-only
// secret, never baked into the image) and fails the whole build with an
// uncaught error instead of just deferring to request time. Found via a
// real `docker build` of frontend/Dockerfile during production-readiness
// review — the same latent bug exists on /health for the same reason.
export const dynamic = "force-dynamic";

export default async function Home() {
  const accounts = await api.listAccounts();
  if (accounts.length === 0) {
    redirect("/setup");
  }
  redirect(`/dashboard/${accounts[0].id}`);
}
