import Link from "next/link";
import { VisitRefresh } from "@/components/visit-refresh";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { Avatar } from "@/components/cleaner-card";
import { Pill } from "@/components/ui";
import { firstName } from "@/lib/cleaners/profile";
import { roomsFor } from "@/lib/service/rooms";
import {
  STAGES,
  STAGE_LABELS,
  isStageReached,
  roomProgress,
  visitHeadline,
  type VisitStage,
  type VisitSummary,
} from "@/lib/visits/progress";
import { formatDateTimeInZone } from "@/lib/time/zone";

/**
 * Screen 6 — the visit, while it is happening.
 *
 * WHAT IS DELIBERATELY NOT HERE: a map. The design had the cleaner's live
 * position on one; see `lib/visits/progress.ts` and `docs/setup.md` item 9 for
 * why that did not survive. What a customer actually wants to know is whether
 * it is going well and when they get their house back, and both are here.
 *
 * Read through `visit_progress`, which is `security_invoker` — so the `0003`
 * policies decide whose visit this is, and a guessed id returns nothing.
 */
export const dynamic = "force-dynamic";

export default async function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (isDemoMode()) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const db = await createClient();

  const { data, error } = await db
    .from("visit_progress")
    .select("*")
    .eq("job_id", id)
    .maybeSingle();

  if (error) throw new Error(`visit_progress: ${error.message}`);
  if (!data) notFound();

  const row = data as Record<string, unknown>;

  // How many rooms this house has, so "4 of 9" means something. The same
  // function the cleaner's own checklist is built from.
  const { data: job } = await db
    .from("jobs")
    .select("properties ( bedrooms, bathrooms )")
    .eq("id", id)
    .maybeSingle();

  const property = ((job as Record<string, unknown> | null)?.["properties"] ?? {}) as Record<
    string,
    unknown
  >;
  const roomsTotal = roomsFor({
    bedrooms: Number(property["bedrooms"] ?? 0),
    bathrooms: Number(property["bathrooms"] ?? 0),
  }).length;

  const visit: VisitSummary = {
    stage: String(row["stage"]) as VisitStage,
    scheduledStart: row["scheduled_start"] ? new Date(String(row["scheduled_start"])) : null,
    startedAt: row["started_at"] ? new Date(String(row["started_at"])) : null,
    completedAt: row["completed_at"] ? new Date(String(row["completed_at"])) : null,
    expectedFinishAt: row["expected_finish_at"]
      ? new Date(String(row["expected_finish_at"]))
      : null,
    roomsDone: Number(row["rooms_done"] ?? 0),
    roomsTotal,
  };

  const cleanerId = typeof row["cleaner_id"] === "string" ? row["cleaner_id"] : null;
  const cleaner = cleanerId ? await new CleanerDirectory(db).get(cleanerId) : null;
  const who = cleaner ? firstName(cleaner.fullName) : null;

  const progress = roomProgress(visit);

  return (
    <>
      <p className="eyebrow">
        {visit.stage === "cleaning" ? "In progress" : STAGE_LABELS[visit.stage]}
      </p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight text-navy">
        {visitHeadline(visit, who)}
      </h1>

      <p className="mt-1 text-sm text-ink-2">
        {visit.startedAt
          ? `Started ${formatDateTimeInZone(visit.startedAt)}`
          : visit.scheduledStart
            ? formatDateTimeInZone(visit.scheduledStart)
            : "Time to be confirmed"}
        {visit.stage === "cleaning" && visit.expectedFinishAt
          ? ` · finishing around ${formatDateTimeInZone(visit.expectedFinishAt)}`
          : ""}
      </p>

      {/* The stage tracker. Four steps, and the one she is on is filled. */}
      <ol className="mt-5 flex items-center gap-1.5">
        {STAGES.map((stage) => {
          const reached = isStageReached(stage, visit.stage);
          return (
            <li key={stage} className="flex-1">
              <div
                className={`h-1.5 rounded-full ${reached ? "bg-sky-deep" : "bg-line"}`}
                aria-hidden
              />
              <p
                className={`mt-1.5 text-[10px] leading-tight ${
                  reached ? "font-medium text-navy" : "text-ink-3"
                }`}
              >
                {STAGE_LABELS[stage]}
              </p>
            </li>
          );
        })}
      </ol>

      {cleaner ? (
        <Link
          href={`/customer/cleaners/${cleaner.id}`}
          className="card mt-5 flex items-center gap-3 p-4 transition-colors hover:border-sky-deep"
        >
          <Avatar cleaner={cleaner} />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-navy">{who}</p>
            <p className="text-xs text-ink-3">Your cleaner · view profile</p>
          </div>
          {cleaner.backgroundCheckCleared ? <Pill tone="good">Vetted</Pill> : null}
        </Link>
      ) : null}

      {progress !== null ? (
        <section className="card mt-4 p-5">
          <div className="flex items-baseline justify-between">
            <p className="eyebrow">Rooms</p>
            <p className="nums text-sm text-navy">
              {visit.roomsDone} of {visit.roomsTotal}
            </p>
          </div>

          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div
              className="h-full rounded-full bg-sky-deep transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>

          <p className="mt-2 text-xs text-ink-3">
            {/*
              Counted from the photographs she takes, which is the same number
              the invoice gate reads. The customer watches the real figure.
            */}
            Counted as each room is finished and photographed.
          </p>
        </section>
      ) : null}

      {visit.stage !== "done" ? <VisitRefresh /> : null}

      <p className="mt-5 text-sm text-ink-2">Need help with this visit? <a href="tel:+14692800397" className="text-navy underline">Call Hey Spotless</a>.</p>

      {visit.stage === "done" ? (
        <Link
          href={`/customer/visits/${id}/rate`}
          className="mt-5 block w-full rounded-lg bg-navy px-4 py-3 text-center text-sm font-semibold text-white"
        >
          Rate this clean
        </Link>
      ) : null}
    </>
  );
}
