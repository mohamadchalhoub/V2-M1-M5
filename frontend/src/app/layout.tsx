import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import { NavBar } from "@/components/NavBar";
import { AutoRefresh } from "@/components/AutoRefresh";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Trading Behavior Monitor",
  description: "Read-only trading-behavior monitoring dashboard",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <AutoRefresh />
        <NavBar />
        <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
