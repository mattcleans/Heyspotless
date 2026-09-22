import Link from "next/link";
import type { ReactNode } from "react";
import { isDemoMode } from "@/lib/supabase/env";

/**
 * The staff chrome: the nav bar with every admin surface on it.
 *
 * WHY THIS IS NO LONGER IN THE ROOT LAYOUT. It used to be, which meant every
 * page in the app wore it — including the three that are for people who do not
 * work here. A homeowner opening the booking link from the Webflow site was
 * shown "Dispatch · Inbox · Leads · Customers · Quote builder · Price book ·
 * Hiring · Reporting", and an applicant reading about the job was shown the
 * same. It told them the internal shape of the business, and it made a booking
 * form look like somebody's back office.
 *
 * So the root layout now carries nothing but the document, and each area asks
 * for the chrome it wants: staff get this, the client app gets its own shell,
 * and /book, /apply and /rate get none at all.
 */
export function OpsChrome({ children }: { children: ReactNode }) {
  return (
    <>
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
          {/*
            Only when it is true. This badge used to be unconditional, so the
            live deployment told everyone who looked that they were seeing demo
            data — which is the one thing a status badge must never get wrong.
          */}
          {isDemoMode() ? (
            <span className="ml-auto rounded-full border border-cream/40 px-2.5 py-0.5 font-mono text-[10px] tracking-widest text-cream uppercase">
              demo data
            </span>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>

      {isDemoMode() ? (
        <footer className="mx-auto max-w-6xl px-5 pb-10 text-xs text-ink-3">
          Running on demo fixtures — no Supabase, Stripe, or Twilio connection. See{" "}
          <code className="font-mono">docs/setup.md</code>.
        </footer>
      ) : null}
    </>
  );
}

const NAV = [
  { href: "/admin", label: "Today" },
  { href: "/admin/dispatch", label: "Dispatch" },
  { href: "/admin/inbox", label: "Inbox" },
  { href: "/admin/leads", label: "Leads" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/quote", label: "Quote builder" },
  { href: "/admin/price-book", label: "Price book" },
  { href: "/admin/applications", label: "Hiring" },
  { href: "/admin/reporting", label: "Reporting" },
  { href: "/cleaner", label: "Cleaner" },
  { href: "/customer", label: "Customer" },
];
