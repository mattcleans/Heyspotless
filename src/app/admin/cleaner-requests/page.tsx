import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { VisitRefresh } from "@/components/visit-refresh";
import { listChoiceReview } from "@/lib/customer/cleaner-choice/store";
import { ReleaseBackupForm } from "./release-form";
import { ReviewChoiceForm } from "./review-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Cleaner requests | Hey Spotless management" };
export default async function Page() {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== "admin")
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to management</h1>
        <Link
          href="/login?next=%2Fadmin%2Fcleaner-requests"
          className="secondary-action mt-4 inline-flex"
        >
          Sign in
        </Link>
      </section>
    );
  const data = repo.isDemo
    ? { requests: [], backups: [] }
    : await listChoiceReview(await createClient());
  return (
    <>
      <h1 className="welcome-title">Client cleaner requests</h1>
      <p className="mt-3 max-w-2xl text-sm text-ink-2">
        Apply an eligible preferred cleaner to normal matching. Applying a
        preference does not create an assignment or promise acceptance. A backup
        requires the client’s approval before work starts.
      </p>
      <p className="mt-2 text-xs text-ink-3">
        Up to 200 pending requests, oldest first, and 200 unapproved backup
        records for unstarted assigned visits.
      </p>
      {repo.isDemo && (
        <p className="preview-note mt-4 rounded-lg">
          Preview only. Live client requests and approvals need an authenticated
          database.
        </p>
      )}
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-navy">
          Preferences to review
        </h2>
        {!data.requests.length ? (
          <p className="visit-feature mt-3">
            No pending requests found in the loaded records.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {data.requests.map((r) => (
              <li key={r.id} className="visit-feature">
                <h3 className="font-semibold text-navy">{r.customerName}</h3>
                <p className="mt-1 text-sm">{r.address}</p>
                <p className="mt-3 text-sm">Requested: {r.cleanerName}</p>
                {r.note && (
                  <p className="mt-2 whitespace-pre-wrap text-sm">{r.note}</p>
                )}
                <Link
                  className="mt-3 inline-flex min-h-11 items-center text-sm underline"
                  href={`/admin/visits/${r.jobId}`}
                >
                  Review visit
                </Link>
                <ReviewChoiceForm
                  id={r.id}
                  canApply={r.canApply}
                  applyBlocker={r.applyBlocker}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-navy">
          Backups awaiting client approval
        </h2>
        {!data.backups.length ? (
          <p className="visit-feature mt-3">
            No unapproved backups found in the loaded records.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {data.backups.map((b, i) => (
              <li key={`${b.jobId}-${i}`} className="visit-feature">
                <h3 className="font-semibold text-navy">{b.customerName}</h3>
                <p className="mt-1 text-sm">{b.address}</p>
                <p className="mt-3 text-sm">
                  {b.backupName} in place of {b.preferredName}
                </p>
                <p className="mt-2 text-sm text-ink-2">
                  {!b.unambiguous
                    ? "The lead assignment needs review."
                    : b.declined
                      ? "Client asked for a different cleaner. Work is blocked until an approved assignment is arranged."
                      : "Client has not approved this backup. Work cannot start yet."}
                </p>
                {b.clientNote && (
                  <p className="mt-3 whitespace-pre-wrap text-sm">
                    Client note: {b.clientNote}
                  </p>
                )}
                <Link
                  className="mt-3 inline-flex min-h-11 items-center text-sm underline"
                  href={`/admin/visits/${b.jobId}`}
                >
                  Review visit
                </Link>
                {b.declined &&
                  b.canRelease &&
                  b.unambiguous &&
                  b.decisionId && (
                    <ReleaseBackupForm
                      jobId={b.jobId}
                      assignmentId={b.assignmentId}
                      preferredCleanerId={b.preferredCleanerId}
                      backupCleanerId={b.backupCleanerId}
                      decisionId={b.decisionId}
                    />
                  )}
                {b.declined && !b.canRelease && b.unambiguous && (
                  <Link
                    href={`/admin/visits/${b.jobId}/replace-lead`}
                    className="secondary-action mt-3"
                  >
                    Review crew lead replacement
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <VisitRefresh label="Refresh requests" />
    </>
  );
}
