import Link from "next/link";
import { PageHeader, Pill } from "@/components/ui";

const SURFACES = [
  {
    href: "/admin/dispatch",
    role: "Admin",
    title: "Dispatch board",
    body: "Jobs needing a cleaner, what the engine decided for each, idle guaranteed hours, and the week's overtime before you commit it.",
    ready: true,
  },
  {
    href: "/admin/quote",
    role: "Admin",
    title: "Quote builder",
    body: "Room counts to a price, off the live price book. Shows the opening cleaner offer alongside the customer total.",
    ready: true,
  },
  {
    href: "/admin/price-book",
    role: "Admin",
    title: "Price book",
    body: "The 9 August 2026 pricelist as structured data, including the recurring rates and extras.",
    ready: true,
  },
  {
    href: "/cleaner",
    role: "Cleaner",
    title: "Today's route",
    body: "Offers with a countdown, on-my-way, clock in/out with a GPS stamp, room checklists, before/after photos.",
    ready: false,
  },
  {
    href: "/customer",
    role: "Customer",
    title: "Portal",
    body: "Quote acceptance, reschedule and skip, invoice history, saved card, rate-your-clean.",
    ready: false,
  },
];

export default function Home() {
  return (
    <>
      <PageHeader eyebrow="Hey Spotless" title="Spotless Ops">
        One system to book, schedule, dispatch, bill, and communicate — plus the thing Housecall Pro
        cannot do at any price: route every job to the cheapest cleaner who will still do it well.
      </PageHeader>

      <ul className="grid gap-3 md:grid-cols-2">
        {SURFACES.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              className="card block h-full p-5 transition-colors hover:border-sky-deep"
            >
              <div className="flex items-center gap-2">
                <span className="eyebrow">{s.role}</span>
                {s.ready ? <Pill tone="good">Built</Pill> : <Pill>Scaffolded</Pill>}
              </div>
              <h2 className="mt-1.5 font-semibold text-navy">{s.title}</h2>
              <p className="mt-1 text-sm text-ink-2">{s.body}</p>
            </Link>
          </li>
        ))}
      </ul>

      <div className="card mt-6 p-5">
        <p className="eyebrow">Where this is</p>
        <p className="mt-1.5 text-sm text-ink-2">
          Phases 1 and 2 of the build plan, plus the pure logic of phases 3 and 5: the schema with
          row-level security, the price book, the quote engine, and the dispatch engine — marginal
          cost, the eligibility gate, the per-hour offer ladder, and route clustering. All of it is
          covered by tests that assert against the figures published in the build plan itself.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          Stripe, Twilio, live Supabase and the Vercel deploy wait on the phase-00 checklist in{" "}
          <code className="font-mono text-xs">docs/setup.md</code>. Start the A2P 10DLC filing
          first — carrier approval takes one to three weeks and it gates everything
          customer-facing.
        </p>
      </div>
    </>
  );
}
