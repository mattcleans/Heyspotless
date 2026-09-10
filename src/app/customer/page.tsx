import { Callout, PageHeader, Pill, Stat } from "@/components/ui";
import { getRepository } from "@/lib/data";
import type { Invoice, PaymentMethod } from "@/lib/data/types";
import { FREQUENCY_LABELS, SERVICE_LABELS } from "@/lib/pricing/price-book";
import { formatCents } from "@/lib/money";
import { formatCalendarDate, formatDateInZone } from "@/lib/time/zone";
import { isBillingEnabled } from "@/lib/stripe/env";
import { PayInvoiceButton, SaveCardButton } from "./billing-actions";

export const metadata = { title: "Your cleans — Spotless Ops" };

export default async function CustomerPage() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  // Demo mode has no session, so there is no profile to look a customer up by.
  // DemoRepository ignores the argument and returns its one demo customer,
  // which is what lets this screen render its card and autopay state at all.
  const customer = profile
    ? await repo.getCustomerByProfile(profile.id)
    : repo.isDemo
      ? await repo.getCustomerByProfile("demo")
      : null;

  // RLS already restricts these to the signed-in customer; the filter is for
  // demo mode, where there is no session to scope by.
  const scope = customer ? { customerId: customer.id } : {};

  const [upcoming, invoices, cards] = await Promise.all([
    repo.listJobs({ ...scope, limit: 3 }),
    repo.listInvoices({ ...scope, limit: 20 }),
    customer ? repo.listPaymentMethods(customer.id) : Promise.resolve([]),
  ]);

  const outstanding = invoices.filter((i) => i.balanceCents > 0 && !i.voidedAt);
  const settled = invoices.filter((i) => i.balanceCents <= 0 || i.voidedAt);
  const owedCents = outstanding.reduce((sum, i) => sum + i.balanceCents, 0);

  const defaultCard = cards.find((c) => c.isDefault) ?? cards[0] ?? null;
  const billingLive = isBillingEnabled();
  const autopayOn = Boolean(customer?.autopayEnabled);
  // Autopay switched on with nothing to charge. It is a real state — removing
  // your last card gets you here — and the whole point of recording it is that
  // the screen can say so instead of quietly showing "On" and charging nobody.
  const autopaySuspended = autopayOn && customer?.autopaySuspendedAt != null;

  return (
    <>
      <PageHeader eyebrow="Customer" title="Your cleans">
        Your upcoming visits, what you owe, and the card we keep on file. Rating a clean feeds
        straight back into who is eligible for future jobs.
      </PageHeader>

      {autopaySuspended ? (
        <Callout tone="warn" label="Autopay is paused">
          {customer?.autopaySuspendedReason
            ? `Autopay is on, but ${customer.autopaySuspendedReason}, so nothing can be charged.`
            : "Autopay is on, but there is no card on file, so nothing can be charged."}{" "}
          Save a card below and it resumes straight away — your existing authorisation still
          stands, so there is nothing to agree to again.
        </Callout>
      ) : null}

      {!billingLive ? (
        <Callout tone="warn" label="Payments are not live yet">
          The Stripe account is still in underwriting, so nothing on this page can take a card
          today. Balances shown are real; the buttons will start working the moment billing is
          switched on, with no change to this screen.
        </Callout>
      ) : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Balance due"
          value={formatCents(owedCents)}
          tone={owedCents > 0 ? "warn" : "good"}
          note={
            outstanding.length === 0
              ? "Nothing outstanding"
              : `${outstanding.length} invoice${outstanding.length === 1 ? "" : "s"}`
          }
        />
        <Stat
          label="Card on file"
          value={defaultCard ? `•••• ${defaultCard.last4 ?? "????"}` : "None"}
          note={defaultCard ? cardNote(defaultCard) : "No saved card"}
        />
        <Stat
          label="Autopay"
          value={autopaySuspended ? "Paused" : autopayOn ? "On" : "Off"}
          tone={autopaySuspended ? "warn" : autopayOn ? "good" : "default"}
          note={
            autopaySuspended
              ? "Save a card to resume — you will not be asked to opt in again"
              : autopayOn
                ? "Charged when a clean is invoiced"
                : "You pay each invoice yourself"
          }
        />
      </div>

      {/* ---------------------------------------------------------- owed --- */}
      <section className="mt-8">
        <h2 className="eyebrow">Outstanding</h2>
        {outstanding.length === 0 ? (
          <p className="mt-2 text-sm text-ink-3">Nothing to pay.</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {outstanding.map((invoice) => (
              <li key={invoice.id} className="card flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="font-medium text-ink">
                    {formatCents(invoice.balanceCents)} due
                    {invoice.dueOn ? ` · ${formatCalendarDate(invoice.dueOn)}` : ""}
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-sm text-ink-3">
                    <Pill tone={invoice.status === "overdue" ? "bad" : "neutral"}>
                      {invoice.status}
                    </Pill>
                    {invoice.amounts.tipCents > 0
                      ? `includes ${formatCents(invoice.amounts.tipCents)} tip`
                      : null}
                  </p>
                  {/*
                    A failed auto-charge is said out loud. The alternative is a
                    customer whose card quietly stopped working discovering it
                    when the service stops.
                  */}
                  {invoice.lastError ? (
                    <p className="mt-1.5 text-xs text-bad">
                      Last attempt failed: {invoice.lastError}
                      {invoice.nextAttemptAt ? ` We will try again on ${formatDateInZone(invoice.nextAttemptAt)}.` : ""}
                    </p>
                  ) : null}
                </div>
                {billingLive ? (
                  <PayInvoiceButton
                    invoiceId={invoice.id}
                    balanceCents={invoice.balanceCents}
                    hasCard={Boolean(defaultCard)}
                  />
                ) : (
                  <span className="nums text-sm text-ink-3">{formatCents(invoice.balanceCents)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------- card --- */}
      <section className="mt-8">
        <h2 className="eyebrow">Payment method</h2>
        <div className="card mt-2 p-4">
          {defaultCard ? (
            <p className="text-sm text-ink">
              <span className="font-medium capitalize">{defaultCard.brand ?? "Card"}</span> ending{" "}
              <span className="nums">{defaultCard.last4 ?? "????"}</span>
              <span className="text-ink-3"> · {cardNote(defaultCard)}</span>
            </p>
          ) : (
            <p className="text-sm text-ink-3">
              No card saved. Adding one lets you pay in a tap, and is required for autopay.
            </p>
          )}
          {billingLive ? (
            <SaveCardButton hasCard={Boolean(defaultCard)} autopayEnabled={autopayOn} />
          ) : null}
        </div>
      </section>

      {/* ------------------------------------------------------- history --- */}
      {settled.length > 0 ? (
        <section className="mt-8">
          <h2 className="eyebrow">Paid</h2>
          <ul className="mt-2 space-y-2">
            {settled.map((invoice) => (
              <li
                key={invoice.id}
                className="card flex items-center justify-between gap-4 px-4 py-3"
              >
                <span className="text-sm text-ink-2">
                  {formatDateInZone(invoice.issuedAt ?? invoice.createdAt)}
                  {invoice.amounts.refundedCents > 0
                    ? ` · ${formatCents(invoice.amounts.refundedCents)} refunded`
                    : ""}
                </span>
                <span className="nums text-sm font-semibold text-navy">
                  {formatCents(invoice.amounts.totalCents)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ------------------------------------------------------ upcoming --- */}
      <section className="mt-8">
        <h2 className="eyebrow">Upcoming</h2>
        <ul className="mt-2 space-y-3">
          {upcoming.map((job) => (
            <li key={job.id} className="card flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium text-ink">
                  {SERVICE_LABELS[job.service]} · {FREQUENCY_LABELS[job.frequency]}
                </p>
                <p className="mt-0.5 text-sm text-ink-3">
                  {job.street}, {job.city}
                  {job.scheduledStart ? ` · ${formatDateInZone(job.scheduledStart)}` : ""}
                </p>
              </div>
              <span className="nums font-semibold text-navy">{formatCents(job.priceCents)}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function cardNote(card: PaymentMethod): string {
  if (!card.expMonth || !card.expYear) return "Saved";
  return `expires ${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`;
}


