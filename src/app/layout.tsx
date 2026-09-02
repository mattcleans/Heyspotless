import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spotless Ops",
  description:
    "Hey Spotless operations — booking, scheduling, dispatch, billing and communications.",
  applicationName: "Spotless Ops",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Spotless Ops" },
};

export const viewport: Viewport = {
  themeColor: "#173c58",
  width: "device-width",
  initialScale: 1,
  // Cleaners use this one-handed on a phone in someone's driveway.
  viewportFit: "cover",
};

const NAV = [
  { href: "/admin/dispatch", label: "Dispatch" },
  { href: "/admin/quote", label: "Quote builder" },
  { href: "/admin/price-book", label: "Price book" },
  { href: "/cleaner", label: "Cleaner" },
  { href: "/customer", label: "Customer" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="bg-navy-deep text-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              Spotless<span className="text-sky"> Ops</span>
            </Link>
            <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-sky/80 transition-colors hover:text-white"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <span className="ml-auto rounded-full border border-cream/40 px-2.5 py-0.5 font-mono text-[10px] tracking-widest text-cream uppercase">
              demo data
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 pb-10 text-xs text-ink-3">
          Running on demo fixtures — no Supabase, Stripe, or Twilio connection. See{" "}
          <code className="font-mono">docs/setup.md</code>.
        </footer>
      </body>
    </html>
  );
}
