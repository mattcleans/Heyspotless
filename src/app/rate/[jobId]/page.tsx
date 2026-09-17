import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";
import { CUSTOMER_BRAND } from "@/lib/brand";
import { formatDateInZone } from "@/lib/time/zone";
import { RateForm } from "./rate-form";

/**
 * The page at the end of the review request.
 *
 * No session, no nav, no chrome from the rest of the app: this is opened from a
 * text message by somebody who has never seen this software and is not going to
 * sign in to answer a one-line question.
 *
 * WHAT IT SHOWS AND WHY SO LITTLE. Enough to prove the link is real — the day,
 * and the first name of whoever cleaned — and nothing else. No address, no
 * price, no customer name. The link travels by SMS, and SMS gets forwarded to
 * family group chats, screenshotted, and left open on shared phones.
 */
export const dynamic = "force-dynamic";

interface RateableJob {
  completedAt: Date | null;
  cleanerFirstName: string | null;
  alreadyRated: boolean;
}

export default async function RatePage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = await load(jobId);

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <p className="eyebrow">{CUSTOMER_BRAND}</p>

      {!job ? (
        <>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy">
            That link has expired
          </h1>
          <p className="mt-2 text-sm text-ink-2">
            It may have been for a clean that has not finished yet, or one that was already
            rated and removed. Nothing is wrong on your end — reply to the text and somebody
            will pick it up.
          </p>
        </>
      ) : (
        <>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy">
            How was your clean?
          </h1>
          <p className="mt-2 mb-5 text-sm text-ink-2">
            {job.cleanerFirstName ? `${job.cleanerFirstName} was there` : "Your clean"}
            {job.completedAt ? ` on ${formatDateInZone(job.completedAt)}` : ""}. It takes one tap,
            and it decides who we send back.
          </p>

          <RateForm jobId={jobId} alreadyRated={job.alreadyRated} />
        </>
      )}
    </div>
  );
}

/**
 * Read through the service role, because there is no session to read as.
 *
 * The function it calls returns a row only for a job that is complete, which is
 * what makes "no row" the right answer to both a wrong id and a clean that has
 * not happened yet.
 */
async function load(jobId: string): Promise<RateableJob | null> {
  if (isDemoMode()) return null;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;

  const { data, error } = await createAdminClient().rpc("rateable_job", { p_job_id: jobId });
  if (error) {
    console.error("rateable_job failed", error);
    return null;
  }

  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
  if (!row) return null;

  return {
    completedAt: row["completed_at"] ? new Date(String(row["completed_at"])) : null,
    cleanerFirstName:
      typeof row["cleaner_first_name"] === "string" && row["cleaner_first_name"]
        ? row["cleaner_first_name"]
        : null,
    alreadyRated: row["already_rated"] === true,
  };
}
