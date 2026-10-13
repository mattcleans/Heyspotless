import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { getRepository } from "@/lib/data";
import { firstName } from "@/lib/cleaners/profile";
import { formatDateInZone } from "@/lib/time/zone";
import { isBillingEnabled } from "@/lib/stripe/env";
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

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (profile?.role !== "customer") notFound();
  const customer = await repo.getCustomerByProfile(profile.id);
  if (!customer) notFound();

  // RLS scopes this to the signed-in customer, so somebody else's clean is
  // simply not there.
  const job = await repo.getJob(id);
  if (!job || job.customerId !== customer.id || job.status !== "complete") notFound();

  const db = await createClient();
  const [progress, assigned, rating] = await Promise.all([
    db.from("jobs").select("completed_at").eq("id", id).maybeSingle(),
    db.from("client_visit_assignments").select("full_name")
      .eq("job_id", id).eq("is_lead", true).limit(2),
    db.from("ratings").select("score,highlights,private_note")
      .eq("job_id", id).eq("customer_id", customer.id).maybeSingle(),
  ]);
  if (progress.error || assigned.error || rating.error) {
    throw new Error("Your rating could not be loaded. Refresh and try again.");
  }
  if (!Array.isArray(assigned.data) || assigned.data.length > 1) {
    throw new Error("Your cleaner assignment needs review. Please contact the office.");
  }

  const row = (progress.data ?? {}) as Record<string, unknown>;
  const cleanerName = assigned.data[0]?.full_name;
  const saved = rating.data;
  const score = saved ? Number(saved.score) : null;
  if (saved && (score === null || !Number.isFinite(score) || score < 1 || score > 5 ||
    !Array.isArray(saved.highlights) || saved.highlights.some((h: unknown) => typeof h !== "string") ||
    (saved.private_note !== null && typeof saved.private_note !== "string"))) {
    throw new Error("Your saved rating could not be loaded. Refresh and try again.");
  }

  const finished = row["completed_at"] ? new Date(String(row["completed_at"])) : null;

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-navy">How did it go?</h1>
      <p className="mt-1 mb-4 text-sm text-ink-2">
        {job.service} · {finished ? formatDateInZone(finished) : "your last clean"}
      </p>

      <RateTipForm
        jobId={id}
        cleanerFirstName={typeof cleanerName === "string" ? firstName(cleanerName) : "your cleaner"}
        cleanPriceCents={job.priceCents}
        tipsEnabled={isBillingEnabled()}
        initialRating={saved && score !== null ? {
          score, highlights: saved.highlights as string[], privateNote: saved.private_note,
        } : null}
      />
    </>
  );
}
