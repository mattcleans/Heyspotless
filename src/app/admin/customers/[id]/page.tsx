import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Pill, Stat } from "@/components/ui";
import { getRepository } from "@/lib/data";
import { formatPhone, formatRooms } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { CustomerForm } from "../customer-form";
import { PropertyForm } from "../property-form";

export const metadata = { title: "Customer — Spotless Ops" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const repo = await getRepository();
  const customer = await repo.getCustomer(id);
  if (!customer) notFound();

  const properties = await repo.listProperties(id);

  return (
    <>
      <PageHeader eyebrow="Admin · Customer" title={`${customer.firstName} ${customer.lastName}`}>
        {[formatPhone(customer.phone), customer.email].filter(Boolean).join(" · ") ||
          "No contact details on file."}
      </PageHeader>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Lifetime value"
          value={formatCents(customer.lifetimeValueCents)}
          note="From paid invoices, recomputed — never entered."
        />
        <Stat
          label="Properties"
          value={String(properties.length)}
          note={properties.length === 0 ? "Add one before quoting." : "Quotable addresses."}
        />
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Properties</h2>

        {properties.length === 0 ? (
          <div className="card p-6 text-center text-sm text-ink-3">
            No properties yet. A quote is priced off beds and baths, so this is the next step.
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
                      {formatRooms(p.rooms.bedrooms, p.rooms.bathrooms, p.rooms.halfBaths ?? 0)}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {p.gateCode ? <Pill tone="sky">Gate {p.gateCode}</Pill> : null}
                    {p.pets ? <Pill tone="warn">Pets</Pill> : null}
                  </div>
                </div>
                {p.accessNotes || p.parkingNotes ? (
                  <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">
                    {[p.accessNotes, p.parkingNotes].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

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
