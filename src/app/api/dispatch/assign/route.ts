import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import type { Job } from "@/lib/data/types";
import type { Cleaner } from "@/lib/dispatch/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { assignDemoJob, offerDemoJob } from "@/lib/demo/added";
import { CLEANER_SHARE_OF_TICKET, payoutForTicket } from "@/lib/pricing/payout";
import { hoursUntil } from "@/lib/dispatch/engine";
import { manualOfferTerms } from "@/lib/dispatch/manual";
import { textOffer, wakeCleaner } from "@/lib/dispatch/notify";
import { MessagingStore, reachabilityOf } from "@/lib/messaging/store";
import { isMessagingEnabled } from "@/lib/messaging/env";
import { sendWindowFor } from "@/lib/messaging/quiet-hours";
import { PushStore } from "@/lib/push/store";
import { isPushEnabled } from "@/lib/push/vapid";
import { formatDateTimeInZone } from "@/lib/time/zone";

/**
 * A manager puts a cleaner on a job, or offers it to one.
 *
 * An EMPLOYEE is assigned. A CONTRACTOR is only offered the job, exclusively,
 * and is on it once she accepts it in her app — scheduling a contractor without
 * asking is the control that makes her an employee, so a manager cannot do it
 * either. The rules live in SQL (`assign_job_manually`, `offer_job_manually`,
 * 0029); this proves the caller is an admin, prices the work the way the
 * engine does, and tells the contractor the offer exists.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFUSALS: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "That job no longer exists." },
  already_assigned: {
    status: 409,
    error: "Somebody already has this job. Refresh to see who.",
  },
  closed: { status: 409, error: "This job has started, finished or been canceled." },
  ineligible: {
    status: 409,
    error: "That cleaner can't take this job (rating, background check, insurance, zone or a clash).",
  },
  contractor: {
    status: 409,
    error: "Contractors are offered jobs, not assigned them. Refresh and try again.",
  },
  not_contractor: {
    status: 409,
    error: "Employees are assigned, not offered jobs. Refresh and try again.",
  },
};

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const body = await readJson(request);
  const jobId = typeof body["jobId"] === "string" ? body["jobId"] : null;
  const cleanerId = typeof body["cleanerId"] === "string" ? body["cleanerId"] : null;
  if (!jobId || !cleanerId) {
    return NextResponse.json({ error: "jobId and cleanerId are required" }, { status: 400 });
  }

  let by: string | null = null;
  if (!repo.isDemo) {
    const profile = await repo.getCurrentProfile();
    if (!profile) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
    if (profile.role !== "admin") {
      return NextResponse.json({ error: "Only an admin can assign cleaners." }, { status: 403 });
    }
    by = profile.id;
  }

  const cleaner = await repo.getCleaner(cleanerId);
  if (!cleaner) {
    return NextResponse.json({ error: "That cleaner is not on the roster." }, { status: 404 });
  }

  const job = repo.isDemo
    ? (await repo.listJobs({ needingCleaner: true })).find((j) => j.id === jobId)
    : await repo.getJob(jobId);
  if (!job) return refuse("not_found");

  return cleaner.type === "contractor_1099"
    ? offer(job, cleaner, by, repo.isDemo, request.nextUrl.origin)
    : assign(job, cleaner, by, repo.isDemo);
}

async function assign(job: Job, cleaner: Cleaner, by: string | null, demo: boolean) {
  // Demo mode has no auth and no database; remember it for the session.
  if (demo) {
    assignDemoJob(job.id, cleaner.id);
    return NextResponse.json({ status: "assigned" });
  }

  const { data, error } = await createAdminClient().rpc("assign_job_manually", {
    p_job_id: job.id,
    p_cleaner_id: cleaner.id,
    p_payout_cents: payoutForTicket(job.priceCents, CLEANER_SHARE_OF_TICKET),
    p_by: by,
  });
  if (error) {
    console.error("assign_job_manually failed", error);
    return NextResponse.json({ error: "Could not save that. Try again." }, { status: 500 });
  }
  if (data !== "assigned") return refuse(String(data));
  return NextResponse.json({ status: "assigned" });
}

async function offer(
  job: Job,
  cleaner: Cleaner,
  by: string | null,
  demo: boolean,
  origin: string,
) {
  const now = new Date();
  const terms = manualOfferTerms(job, now);
  const answer = {
    status: "offered",
    expiresAt: terms.expiresAt.toISOString(),
    message: `${cleaner.name} has been offered this job and is on it once she accepts (by ${formatDateTimeInZone(terms.expiresAt)}).`,
  };

  if (demo) {
    offerDemoJob(job.id, cleaner.id, terms.expiresAt);
    return NextResponse.json(answer);
  }

  const db = createAdminClient();
  const messaging = new MessagingStore(db);
  const pushStore = new PushStore(db);
  const announcing = isMessagingEnabled();

  // Checked before the offer is written, the same as the sweep: an offer she
  // can't be told about starts a countdown she can't answer, and counts
  // against her when it lapses.
  const recipient = (await messaging.recipientsFor([cleaner.id])).get(cleaner.id);
  const reach = reachabilityOf(recipient);
  if (announcing && !reach.reachable) {
    const why =
      reach.reason === "opted_out" ? "has turned off texts" : "has no phone number on file";
    return NextResponse.json(
      { error: `${cleaner.name} ${why}, so she wouldn't see the offer.` },
      { status: 409 },
    );
  }
  if (announcing) {
    const window = sendWindowFor(now, { hoursUntilJob: hoursUntil(job, now) });
    if (!window.send) {
      return NextResponse.json(
        {
          error: `It's quiet hours, so ${cleaner.name} can't be texted now. Try again after ${formatDateTimeInZone(window.nextOpening)}.`,
        },
        { status: 409 },
      );
    }
  }

  const { data, error } = await db.rpc("offer_job_manually", {
    p_job_id: job.id,
    p_cleaner_id: cleaner.id,
    p_share: terms.share,
    p_payout_cents: terms.payoutCents,
    p_expires_at: terms.expiresAt.toISOString(),
    p_by: by,
  });
  if (error) {
    console.error("offer_job_manually failed", error);
    return NextResponse.json({ error: "Could not send that offer. Try again." }, { status: 500 });
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: unknown; offer_id?: unknown }
    | null
    | undefined;
  const outcome = String(row?.outcome ?? "");
  const offerId = typeof row?.offer_id === "string" ? row.offer_id : null;
  if (outcome !== "offered" || !offerId) return refuse(outcome);

  // The offer stands whatever happens to the notifications; a failed text is
  // recorded against the message, not the offer.
  const deps = {
    messaging,
    pushStore,
    pushTargets: isPushEnabled() ? await pushStore.targetsFor([cleaner.id]) : new Map(),
    origin,
  };
  try {
    await wakeCleaner(deps, cleaner.id);
    if (announcing && reach.reachable && recipient) {
      await textOffer(deps, {
        offerId,
        job,
        cleanerId: cleaner.id,
        recipient,
        phone: reach.phone,
        payoutCents: terms.payoutCents,
        expiresAt: terms.expiresAt,
        isExclusive: true,
      });
    }
  } catch (error) {
    console.error(`notifying cleaner ${cleaner.id} of offer ${offerId} failed`, error);
  }

  return NextResponse.json(answer);
}

function refuse(outcome: string) {
  const refusal = REFUSALS[outcome] ?? { status: 409, error: "That was refused." };
  return NextResponse.json({ error: refusal.error }, { status: refusal.status });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
