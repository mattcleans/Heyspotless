import Link from "next/link";
import type { ReactNode } from "react";
import { CUSTOMER_BRAND } from "@/lib/brand";

/**
 * The client app shell.
 *
 * A PHONE APP, NOT A PAGE OF THE OPS TOOL. Narrow column, a title bar with the
 * customer brand rather than the product name, and a bottom tab bar — because
 * this is opened one-handed from a text message, usually by somebody who has
 * never seen the rest of this software and never should.
 *
 * The customer-facing name is Hey Spotless. "Spotless Ops" is what the people
 * who work here call the tool, and it appears nowhere below.
 */
export default function ClientAppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-surface">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <Link href="/customer" className="font-semibold tracking-tight text-navy">
          {CUSTOMER_BRAND}
        </Link>
      </header>

      {/* Bottom padding clears the tab bar, including the home indicator. */}
      <main className="flex-1 px-4 pt-4 pb-28">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <ul className="flex">
          {TABS.map((tab) => (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                className="flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium text-ink-3 transition-colors hover:text-navy"
              >
                <span aria-hidden className="text-base leading-none">
                  {tab.icon}
                </span>
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

const TABS = [
  { href: "/customer", label: "Home", icon: "⌂" },
  { href: "/customer/cleaners", label: "Cleaners", icon: "◍" },
  { href: "/customer/visits", label: "Visits", icon: "◷" },
  { href: "/customer/account", label: "Account", icon: "◉" },
];
