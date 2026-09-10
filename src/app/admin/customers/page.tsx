import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getRepository } from "@/lib/data";
import { formatCents } from "@/lib/money";
import { formatPhone } from "@/lib/format";

export const metadata = { title: "Customers — Spotless Ops" };

export default async function CustomersPage() {
  const repo = await getRepository();
  const customers = await repo.listCustomers();

  return (
    <>
      <PageHeader eyebrow="Admin" title="Customers">
        Every customer and the properties they own. Lifetime value is computed from paid
        invoices, never entered by hand.
      </PageHeader>

      <div className="mb-4 flex justify-end">
        <Link
          href="/admin/customers/new"
          className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-deep"
        >
          New customer
        </Link>
      </div>

      {customers.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-3">
          No customers yet. Add the first one to start quoting.
        </div>
      ) : (
        <ul className="space-y-2">
          {customers.map((c) => (
            <li key={c.id}>
              <Link
                href={`/admin/customers/${c.id}`}
                className="card flex items-center justify-between gap-4 p-4 transition-colors hover:border-sky-deep"
              >
                <div>
                  <p className="font-medium text-ink">
                    {c.firstName} {c.lastName}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-3">
                    {[formatPhone(c.phone), c.email].filter(Boolean).join(" · ") ||
                      "No contact details"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="nums font-semibold text-navy">
                    {formatCents(c.lifetimeValueCents)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-3">lifetime</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
