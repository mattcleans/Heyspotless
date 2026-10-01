import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, Pill } from "@/components/ui";
import { JobFlow } from "./job-flow";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { ServiceStore } from "@/lib/service/store";
import { roomsFor } from "@/lib/service/rooms";
import { isDemoMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { formatCents, formatHours } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { JOB_LABELS } from "@/lib/experience/schedule";

export const metadata = { title: "Visit | Hey Spotless" };
export const dynamic = "force-dynamic";

/**
 * The job a cleaner is standing outside.
 *
 * Everything on this page is what she needs before she knocks — the address,
 * the gate code, the dog — followed by the one button that matches where she
 * is in the job. The dispatch reasoning that produced it is not hers to see
 * and is deliberately absent.
 */
export default async function CleanerJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();

  // Demo mode has no auth, so there is no profile to look a cleaner up by —
  // the fixture repository answers regardless. Without this branch the whole
  // flow hides itself in the one mode that exists to show it.
  const cleaner = profile
    ? await repo.getCleanerByProfile(profile.id)
    : repo.isDemo
      ? await repo.getCleanerByProfile("demo")
      : null;

  const job = await repo.getJob(id);
  if (!job) notFound();

  const property = await repo.getProperty(job.propertyId);
  const rooms = roomsFor(property?.rooms ?? { bedrooms: job.bedrooms, bathrooms: job.bathrooms });

  // What the server already has. A reinstalled app, or a second phone, must
  // not ask her to reshoot rooms that are already in.
  // A photo with no room attached satisfies no room, so it is not "already
  // done" for anything and is dropped here rather than confusing the screen.
  const alreadyDone = isDemoMode()
    ? []
    : (await new ServiceStore(createAdminClient()).photosFor(id)).flatMap((photo) =>
        photo.roomKey ? [{ roomKey: photo.roomKey, kind: photo.kind }] : [],
      );

  const status = toFlowStatus(job.status);
  let payout: number | null = null;
  if (cleaner && !repo.isDemo && cleaner.type !== "w2_core") {
    const db = await createClient();
    const { data, error } = await db.from("job_assignments")
      .select("payout_cents").eq("job_id", id).eq("cleaner_id", cleaner.id).maybeSingle();
    if (error) throw new Error("Unable to load your agreed pay. Please try again.");
    payout = data?.payout_cents == null ? null : Number(data.payout_cents);
  }
  const directions = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${job.street}, ${job.city}`)}`;

  return (
    <>
      <PageHeader eyebrow="Job" title={job.customerName}>
        {job.street}, {job.city}
      </PageHeader>

      <p className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={status === "complete" ? "good" : "sky"}>
          {JOB_LABELS[job.status] ?? "Check visit details"}
        </Pill>
        <span className="nums text-sm text-navy">{cleaner?.type === "w2_core"
          ? "Paid under your hourly terms"
          : payout !== null ? `${formatCents(payout)} agreed pay` : "Pay details with the office"}</span>
        <span className="text-xs text-ink-3">
          {job.scheduledStart ? formatDateTimeInZone(job.scheduledStart) : "Unscheduled"} ·{" "}
          about {formatHours(job.estimatedCleanMinutes)}
        </span>
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <a href={directions} target="_blank" rel="noopener noreferrer" className="secondary-action">Open directions</a>
        <a href="tel:+14692800397" className="secondary-action">Call the office</a>
      </div>

      {/* Everything nobody remembers to ask on the doorstep. */}
      {property && (property.gateCode || property.accessNotes || property.parkingNotes || property.pets) && (
        <dl className="card mt-4 space-y-2 p-4 text-sm">
          {property.gateCode && <Detail term="Gate code" value={property.gateCode} />}
          {property.parkingNotes && <Detail term="Parking" value={property.parkingNotes} />}
          {property.accessNotes && <Detail term="Getting in" value={property.accessNotes} />}
          {property.pets && <Detail term="Pets" value={property.pets} />}
        </dl>
      )}

      {job.status === "canceled" ? (
        <p className="visit-feature mt-5">This visit was canceled. You do not need to start it. Call the office if you have questions.</p>
      ) : cleaner ? (
        <>
          {repo.isDemo && (
            <p className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
              Demo mode. The room list and the photo queue are real — photos are saved to this
              browser before anything touches the network — but starting and finishing a job
              needs a live database.
            </p>
          )}
          <JobFlow
            jobId={id}
            initialStatus={status}
            rooms={rooms}
            alreadyDone={alreadyDone}
          />
        </>
      ) : (
        <p className="mt-6 text-sm text-ink-3">
          Sign in as a cleaner to start this job.
        </p>
      )}

      <p className="mt-8">
        <Link href="/cleaner" className="text-sm text-ink-3 underline">
          Back to today
        </Link>
      </p>
    </>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-ink-3">{term}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

/**
 * Anything that is not started or finished is treated as in progress.
 *
 * `dispatching` and `scheduled` reach here when she has opened a job the board
 * has not caught up with. Showing her a Start button is the right answer for
 * all of them — `start_job` refuses what it should and the screen stays honest.
 */
function toFlowStatus(status: string): "assigned" | "in_progress" | "complete" {
  if (status === "complete") return "complete";
  if (status === "in_progress") return "in_progress";
  return "assigned";
}
