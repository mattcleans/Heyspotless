import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { getRepository } from "@/lib/data";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { firstName } from "@/lib/cleaners/profile";
import { formatDateInZone } from "@/lib/time/zone";
import { RateTipForm } from "./rate-tip-form";

/**
 * Screen 7 — rate and tip, in the app.
 *
 * The SMS route to the same thing is `/rate/[jobId]`, which needs no sign-in
 * because it is opened from a text. This one is for somebody already in the
 * app, and it can therefore offer the tip: a tip needs a card on file and a
 * session to attach it to, and a public link has neither.
 */
export const dynamic = "force-dynamic";

export default async function RateVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (isDemoMode()) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const db = await createClient();
  const repo = await getRepository();

  // RLS scopes this to the signed-in customer, so somebody else's clean is
  // simply not there.
  const job = await repo.getJob(id);
  if (!job || job.status !== "complete") notFound();

  const { data: progress } = await db
    .from("visit_progress")
    .select("cleaner_id, completed_at")
    .eq("job_id", id)
    .maybeSingle();

  const row = (progress ?? {}) as Record<string, unknown>;
  const cleanerId = typeof row["cleaner_id"] === "string" ? row["cleaner_id"] : null;
  const cleaner = cleanerId ? await new CleanerDirectory(db).get(cleanerId) : null;

  const finished = row["completed_at"] ? new Date(String(row["completed_at"])) : null;

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-navy">How did it go?</h1>
      <p className="mt-1 mb-4 text-sm text-ink-2">
        {job.service} · {finished ? formatDateInZone(finished) : "your last clean"}
      </p>

      <RateTipForm
        jobId={id}
        cleanerFirstName={cleaner ? firstName(cleaner.fullName) : "your cleaner"}
        cleanPriceCents={job.priceCents}
      />
    </>
  );
}
