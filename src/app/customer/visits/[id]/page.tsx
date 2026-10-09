import { recurringVisitChanges } from "@/lib/customer/recurring/store";
import { RecurringVisitChanges } from "@/components/recurring-visit-changes";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DemoVisit } from "@/components/demo-visit";
import { CustomerVisitDetails } from "@/components/customer-visit-details";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { loadCustomerVisit } from "@/lib/visits/customer-visit-store";

export const dynamic = "force-dynamic";
export const metadata = { title: "Visit details | Hey Spotless" };

export default async function VisitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repo = await getRepository();
  if (repo.isDemo) return <DemoVisit id={id} />;
  const profile = await repo.getCurrentProfile();
  if (!profile || !["customer", "admin"].includes(profile.role))
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to see your visit</h1>
        <Link
          className="secondary-action mt-4 inline-flex"
          href={`/login?next=${encodeURIComponent(`/customer/visits/${id}`)}`}
        >
          Sign in
        </Link>
      </section>
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    notFound();
  const db = await createClient();
  const details = await loadCustomerVisit(db, id);
  if (!details) notFound();
  const cleaner =
    details.cleanerId && details.summary.stage !== "canceled"
      ? await new CleanerDirectory(db).get(details.cleanerId)
      : null;
  const changes = await recurringVisitChanges(db, id);
  return (
    <>
      <CustomerVisitDetails id={id} details={details} cleaner={cleaner} />
      <RecurringVisitChanges
        changes={changes}
        office={profile.role === "admin"}
      />
    </>
  );
}
