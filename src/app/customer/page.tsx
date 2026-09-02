import { PageHeader, Callout } from "@/components/ui";
import { DEMO_JOBS } from "@/lib/demo/fixtures";
import { FREQUENCY_LABELS, SERVICE_LABELS } from "@/lib/pricing/price-book";
import { formatCents } from "@/lib/money";

export const metadata = { title: "Your cleans — Spotless Ops" };

export default function CustomerPage() {
  const mine = DEMO_JOBS.slice(0, 3);

  return (
    <>
      <PageHeader eyebrow="Customer" title="Your cleans">
        Quote acceptance, reschedule and skip, invoice history, saved card, and rate-your-clean —
        the rating feeds straight back into who is eligible for future jobs.
      </PageHeader>

      <Callout tone="warn" label="Scaffolded, not built">
        Card on file and auto-charge are phase 3 and wait on Stripe underwriting. The rating
        submitted here is the same score the dispatch eligibility gate reads, so it is wired to the
        schema even though the screen is a stub.
      </Callout>

      <ul className="mt-6 space-y-3">
        {mine.map((job) => (
          <li key={job.id} className="card flex items-center justify-between gap-4 p-4">
            <div>
              <p className="font-medium text-ink">
                {SERVICE_LABELS[job.service]} · {FREQUENCY_LABELS[job.frequency]}
              </p>
              <p className="mt-0.5 text-sm text-ink-3">
                {job.street}, {job.city}
                {job.scheduledStart
                  ? ` · ${job.scheduledStart.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`
                  : ""}
              </p>
            </div>
            <span className="nums font-semibold text-navy">{formatCents(job.priceCents)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
