import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { CustomerForm } from "../customer-form";

export const metadata = { title: "New customer — Spotless Ops" };

export default function NewCustomerPage() {
  return (
    <>
      <PageHeader eyebrow="Admin" title="New customer">
        Contact details now, properties once they exist. A customer needs at least one way to
        be reached.
      </PageHeader>

      <div className="card p-5">
        <CustomerForm />
      </div>

      <p className="mt-4 text-sm">
        <Link href="/admin/customers" className="text-ink-3 hover:text-navy">
          ← Back to customers
        </Link>
      </p>
    </>
  );
}
