import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Pill, Stat } from "@/components/ui";
import { getRepository } from "@/lib/data";
import { formatPhone, formatRooms } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { FREQUENCY_LABELS, SERVICE_LABELS } from "@/lib/pricing/price-book";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore, type CustomerPayment } from "@/lib/billing/store";
import { isBillingEnabled } from "@/lib/stripe/env";
import { refundChoice } from "@/lib/billing/refund-options";
import { RefundAction } from "@/components/refund-action";
import { BookingForm } from "../booking-form";
import { CustomerForm } from "../customer-form";
import { PropertyForm } from "../property-form";

export const metadata = { title: "Customer | Hey Spotless management" };

export default async function CustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const repo = await getRepository();
  const customer = await repo.getCustomer(id);
  if (!customer) notFound();

  const [properties, jobs, profile] = await Promise.all([
    repo.listProperties(id),
    repo.listJobs({ customerId: id }),
    repo.getCurrentProfile(),
  ]);

  // Payments are read with the service role, so the role check here is the
  // boundary, as on the reporting page. Demo mode has no real payments.
  let payments: CustomerPayment[] | null = null;
  let paymentsUnavailable = false;
  if (!repo.isDemo && profile?.role === "admin") {
    try {
      payments = await new BillingStore(createAdminClient()).listCustomerPayments(id);
    } catch {
      paymentsUnavailable = true;
    }
  }
  const refundsEnabled = isBillingEnabled();
  const customerName = `${customer.firstName} ${customer.lastName}`.trim() || "the client";

  return (
    <>
      <PageHeader
        eyebrow="Admin · Customer"
        title={`${customer.firstName} ${customer.lastName}`}
      >
        {[formatPhone(customer.phone), customer.email]
          .filter(Boolean)
          .join(" · ") || "No contact details on file."}
      </PageHeader>

      <Link
        href={`/admin/customers/${id}/schedules`}
        className="secondary-action mb-5 inline-flex"
      >
        Manage recurring schedules
      </Link>
      <Link
        href={`/admin/customers/${id}/quotes`}
        className="secondary-action mb-5 ml-2 inline-flex"
      >
        Prepare and review quotes
      </Link>
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Lifetime value"
          value={formatCents(customer.lifetimeValueCents)}
          note="From paid invoices, recomputed — never entered."
        />
        <Stat
          label="Properties"
          value={String(properties.length)}
          note={
            properties.length === 0
              ? "Add one before quoting."
              : "Quotable addresses."
          }
        />
        <Stat
          label="Cleans booked"
          value={String(jobs.length)}
          note={
            jobs.length === 0
              ? "Nothing on the board yet."
              : "Visible on dispatch."
          }
        />
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Properties</h2>

        {properties.length === 0 ? (
          <div className="card p-6 text-center text-sm text-ink-3">
            No properties yet. A quote is priced off beds and baths, so this is
            the next step.
          </div>
        ) : (
          <ul className="space-y-2">
            {properties.map((p) => (
              <li key={p.id} className="card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-ink">{p.street}</p>
                    <p className="mt-0.5 text-sm text-ink-3">
                      {p.city}, {p.state} {p.zip}
                    </p>
                    <p className="nums mt-1 text-xs text-ink-3">
                      {formatRooms(
                        p.rooms.bedrooms,
                        p.rooms.bathrooms,
                        p.rooms.halfBaths ?? 0,
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {p.gateCode ? (
                      <Pill tone="sky">Gate {p.gateCode}</Pill>
                    ) : null}
                    {p.pets ? <Pill tone="warn">Pets</Pill> : null}
                  </div>
                </div>
                {p.accessNotes || p.parkingNotes ? (
                  <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">
                    {[p.accessNotes, p.parkingNotes]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Cleans</h2>

        {jobs.length === 0 ? (
          <div className="card p-6 text-center text-sm text-ink-3">
            Nothing booked yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="card flex items-center justify-between gap-4 p-4"
              >
                <div>
                  <Link
                    href={`/admin/visits/${job.id}`}
                    className="font-medium text-ink underline"
                  >
                    {SERVICE_LABELS[job.service]} ·{" "}
                    {FREQUENCY_LABELS[job.frequency]}
                  </Link>
                  <p className="mt-0.5 text-sm text-ink-3">
                    {job.street}
                    {job.scheduledStart
                      ? ` · ${formatDateTimeInZone(job.scheduledStart)}`
                      : " · unscheduled"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Pill tone={job.status === "unscheduled" ? "warn" : "sky"}>
                    {job.status}
                  </Pill>
                  <span className="nums font-semibold text-navy">
                    {formatCents(job.priceCents)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {payments !== null || paymentsUnavailable ? (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">Payments</h2>
          {paymentsUnavailable ? (
            <div className="card p-6 text-sm text-ink-3" role="alert">
              Payments could not be loaded. Refresh before refunding anything.
            </div>
          ) : payments && payments.length === 0 ? (
            <div className="card p-6 text-center text-sm text-ink-3">No payments yet.</div>
          ) : (
            <ul className="space-y-2">
              {payments?.map((p) => (
                <li key={p.id} className="card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="nums font-semibold text-navy">{formatCents(p.amountCents)}</p>
                      <p className="mt-0.5 text-sm text-ink-3">
                        {p.paidAt ? formatDateTimeInZone(p.paidAt) : "Date unknown"} · invoice{" "}
                        <span className="nums">{p.invoiceId.slice(0, 8)}</span>
                      </p>
                      {p.refunds.length > 0 ? (
                        <ul className="mt-2 space-y-0.5 text-sm text-ink-2">
                          {p.refunds.map((r, i) => (
                            <li key={i}>
                              Refund <span className="nums">{formatCents(r.amountCents)}</span> ·{" "}
                              {refundChoice(r.kind)?.label ?? "No reason recorded (Stripe dashboard)"}
                              {r.status !== "succeeded" ? ` · ${r.status}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <Pill tone={p.status === "succeeded" ? (p.refundableCents === 0 ? "warn" : "sky") : "warn"}>
                      {p.status === "succeeded" && p.refundableCents === 0 && p.refunds.length > 0 ? "refunded" : p.status}
                    </Pill>
                  </div>
                  {refundsEnabled && p.stripePaymentIntentId && p.refundableCents > 0 ? (
                    <div className="mt-3">
                      <RefundAction
                        paymentIntentId={p.stripePaymentIntentId}
                        refundableCents={p.refundableCents}
                        customerName={customerName}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {properties.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">Book a clean</h2>
          <div className="card p-5">
            <BookingForm customerId={customer.id} properties={properties} />
          </div>
        </section>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Add a property</h2>
        <div className="card p-5">
          <PropertyForm customerId={customer.id} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">Contact details</h2>
        <div className="card p-5">
          <CustomerForm customer={customer} />
        </div>
      </section>

      <p className="mt-6 text-sm">
        <Link href="/admin/customers" className="text-ink-3 hover:text-navy">
          ← Back to customers
        </Link>
      </p>
    </>
  );
}
