import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { listCancellations } from "@/lib/customer/cancellation/store";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { VisitRefresh } from "@/components/visit-refresh";
import { ResolveCancellationForm } from "./resolve-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Cancellations | Hey Spotless management" };
export default async function Page() {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== "admin")
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to management</h1>
        <Link
          href="/login?next=%2Fadmin%2Fcancellations"
          className="secondary-action mt-4 inline-flex"
        >
          Sign in
        </Link>
      </section>
    );
  const receipts = repo.isDemo
    ? []
    : await listCancellations(await createClient());
  const records = await Promise.all(
    receipts.map(async (receipt) => ({
      receipt,
      job: await repo.getJob(receipt.jobId),
    })),
  );
  return (
    <>
      <h1 className="welcome-title">Canceled visits</h1>
      <p className="mt-3 text-sm text-ink-2">
        Latest 100 cancellations. Same-day cancellations and door turnaways have
        a $60 fee. A skipped visit keeps the rest of the recurring schedule.
      </p>
      {repo.isDemo && (
        <p className="preview-note mt-4 rounded-lg">
          Preview only. Live cancellation records need an authenticated
          database.
        </p>
      )}
      <section className="mt-5">
        <h2 className="text-lg font-semibold">Billing needs review</h2>
        <p className="mt-2 text-sm text-ink-2">
          For these visits, inspect existing payments and payment attempts
          before refunding, adjusting the balance, or collecting the fee.
          Further collection for the canceled clean is paused.
        </p>
        {records.filter((r) => r.receipt.billingReview).length === 0 && (
          <p className="visit-feature mt-3">
            No billing review flags found in the loaded cancellations.
          </p>
        )}
        {records
          .filter((r) => r.receipt.billingReview)
          .map(({ receipt, job }) => (
            <article key={receipt.id} className="visit-feature mt-3">
              <h3 className="font-semibold">
                {job?.customerName ?? "Client visit"}
              </h3>
              <p className="mt-2 text-sm">
                {job
                  ? `${job.street}, ${job.city}`
                  : "Address unavailable; open the visit to check details."}
              </p>
              <p className="mt-2 text-sm">
                Cancellation fee recorded: {formatCents(receipt.feeCents)}. No
                additional fee invoice was created.
              </p>
              <Link
                href={`/admin/visits/${receipt.jobId}`}
                className="secondary-action mt-4 inline-flex"
              >
                Review visit and invoices
              </Link>
              <ResolveCancellationForm
                jobId={receipt.jobId}
                cancellationId={receipt.id}
              />
            </article>
          ))}
      </section>
      <section className="mt-6">
        <h2 className="text-lg font-semibold">Cancellation history</h2>
        {!records.length && (
          <p className="mt-3 text-sm">
            No cancellations found in the loaded records.
          </p>
        )}
        <ul className="mt-3 space-y-3">
          {records.map(({ receipt, job }) => (
            <li key={receipt.id} className="card p-4">
              <Link
                href={`/admin/visits/${receipt.jobId}/cancel`}
                className="inline-flex min-h-11 items-center font-semibold underline"
              >
                {job?.customerName ?? "Client visit"}
              </Link>
              <p className="text-sm">
                {receipt.reason === "door_turnaway"
                  ? "Door turnaway"
                  : receipt.reason === "skip"
                    ? "Skipped visit"
                    : "Canceled visit"}{" "}
                · {formatCents(receipt.feeCents)} fee
              </p>
              <p className="mt-1 text-xs text-ink-2">
                Recorded {formatDateTimeInZone(new Date(receipt.canceledAt))}
              </p>
            </li>
          ))}
        </ul>
      </section>
      {!repo.isDemo && <VisitRefresh />}
    </>
  );
}
