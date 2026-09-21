"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Every page in this app is a Server Component fetching from api.ts, which
// already sets `cache: 'no-store'` on every backend call — so a plain
// router.refresh() (re-runs Server Components, re-fetches, merges the new
// RSC payload without losing client-side state like scroll position or a
// form's own useState) always gets genuinely current data, never a stale
// cached response. Mounted once in the root layout, so this covers every
// page/section without each one needing its own polling logic.
const REFRESH_INTERVAL_MS = 5_000;

export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      // Skip while the tab isn't visible — no point re-fetching a page
      // nobody's looking at; it refreshes immediately on tab focus instead
      // (the visibilitychange listener below).
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, REFRESH_INTERVAL_MS);

    function onVisible() {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
