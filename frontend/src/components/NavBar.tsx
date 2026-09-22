"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// "Trend Breakout" was removed with the strategy migration: that module is no
// longer registered in the backend, so the link could only ever have led to an
// error page.
const ACCOUNT_SCOPED_ROUTES = [
  { label: "Dashboard", segment: "dashboard" },
  { label: "Alerts", segment: "alerts" },
  { label: "History", segment: "history" },
  { label: "Rules", segment: "rules" },
  { label: "Imports", segment: "imports" },
  { label: "EURUSD Charts", segment: "eurusd-charts" },
  { label: "Technical Analysis", segment: "technical-analysis" },
];

function currentAccountId(pathname: string): string | null {
  const match = pathname.match(/^\/(dashboard|alerts|history|rules|imports|eurusd-charts|technical-analysis)\/([^/]+)/);
  return match ? match[2] : null;
}

export function NavBar() {
  const pathname = usePathname();
  const accountId = currentAccountId(pathname);

  return (
    <header className="border-b border-border bg-surface">
      {/* Eight nav items plus the brand name are wider than any phone
          viewport — rather than a hamburger menu (a bigger rebuild), this
          scrolls horizontally as a swipeable tab strip, a well-established
          mobile nav pattern. shrink-0 + whitespace-nowrap keep flex from
          squishing/wrapping items instead of letting the row scroll. */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-4 sm:gap-8 overflow-x-auto">
        <span className="font-semibold tracking-tight text-accent whitespace-nowrap shrink-0">Trading Behavior Monitor</span>
        <nav className="flex items-center gap-1 text-sm shrink-0">
          {ACCOUNT_SCOPED_ROUTES.map((route) => {
            const href = accountId ? `/${route.segment}/${accountId}` : `/${route.segment}`;
            const active = pathname.startsWith(`/${route.segment}`);
            return (
              <Link
                key={route.segment}
                href={href}
                className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                  active ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:text-text"
                }`}
              >
                {route.label}
              </Link>
            );
          })}
          <Link
            href="/xauusd-m1m5"
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              pathname.startsWith("/xauusd-m1m5") ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:text-text"
            }`}
          >
            XAUUSD M1/M5 (live)
          </Link>
          <Link
            href="/xauusd-rsi"
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              pathname.startsWith("/xauusd-rsi") ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:text-text"
            }`}
          >
            XAUUSD RSI (live)
          </Link>
          <Link
            href="/market-charts"
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              pathname.startsWith("/market-charts") ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:text-text"
            }`}
          >
            Market Charts
          </Link>
          <Link
            href="/research/xauusd-confirmed-retest"
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              pathname.startsWith("/research") ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:text-text"
            }`}
          >
            Gold Retest Research
          </Link>
          <Link
            href="/gold-demo"
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              pathname.startsWith("/gold-demo") ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:text-text"
            }`}
          >
            Gold (retired)
          </Link>
          <Link
            href="/health"
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              pathname.startsWith("/health") ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:text-text"
            }`}
          >
            Health
          </Link>
        </nav>
      </div>
    </header>
  );
}
