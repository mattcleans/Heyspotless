import { PageHeader, Pill, Stat } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { formatPhone } from "@/lib/format";
import { formatDateInZone } from "@/lib/time/zone";
import { SCREEN_QUESTIONS, screenScore } from "@/lib/recruiting/screen";
import { ApplicationActions } from "./application-actions";

/**
 * The hiring queue.
 *
 * WHY THIS SCREEN EXISTS AT ALL, past the obvious. The build plan calls the
 * recruiting funnel launch-critical, and the reason is not staffing in the
 * ordinary sense: an auction with four cleaners is not an auction. Every
 * mechanism in the dispatch engine — the ladder, the tiers, the marginal-cost
 * ceiling — assumes somebody is competing for the work. Supply is what makes
 * the rest of this software worth more than a spreadsheet.
 *
 * The score orders the list and nothing else. Nobody is filtered out by it, and
 * in a labour market this thin the cost of wrongly rejecting a good cleaner is
 * far higher than the cost of reading every application.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Applications — Spotless Ops" };

interface ApplicationRow {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  yearsExperience: number | null;
  hasVehicle: boolean | null;
  workAuthorized: boolean | null;
  hasOwnInsurance: boolean | null;
  insuranceExpiresOn: string | null;
  serviceZips: string[];
  screenAnswers: Record<string, string> | null;
  screenScore: number | null;
  rejectedReason: string | null;
  cleanerId: string | null;
  submittedAt: Date;
}

const OPEN = ["submitted", "screened", "background_pending", "background_cleared"];

export default async function ApplicationsPage() {
  if (isDemoMode()) {
    return (
      <>
        <PageHeader eyebrow="Admin" title="Applications">
          The hiring queue.
        </PageHeader>
        <div className="card p-8 text-center text-sm text-ink-3">
          Applications need a live database — every row in here is somebody who applied.
        </div>
      </>
    );
  }

  const applications = await load();

  const open = applications
    .filter((a) => OPEN.includes(a.status))
    .map((a) => ({ application: a, score: a.screenScore ?? computed(a) }))
    .sort((x, y) => y.score - x.score);

  const closed = applications.filter((a) => !OPEN.includes(a.status));
  const active = applications.filter((a) => a.status === "activated").length;

  return (
    <>
      <PageHeader eyebrow="Admin" title="Applications">
        Supply for the marketplace. An auction with four cleaners is not an auction — every
        rung of the offer ladder assumes somebody else might take the job.
      </PageHeader>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat label="Waiting on us" value={String(open.length)} tone={open.length > 0 ? "warn" : "good"} />
        <Stat label="Activated" value={String(active)} note="On the roster and offerable." />
        <Stat
          label="Awaiting a check"
          value={String(applications.filter((a) => a.status === "background_pending").length)}
          note="The only step that takes more than a day."
        />
      </div>

      {open.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-3">
          Nothing in the queue. The public form is at{" "}
          <code className="font-mono text-xs">/apply</code>.
        </div>
      ) : (
        <ul className="space-y-3">
          {open.map(({ application, score }) => (
            <Card key={application.id} application={application} score={score} />
          ))}
        </ul>
      )}

      {closed.length > 0 ? (
        <section className="mt-8">
          <p className="eyebrow mb-2">Closed</p>
          <ul className="space-y-2">
            {closed.map((application) => (
              <li
                key={application.id}
                className="card flex items-center justify-between gap-3 p-3 text-sm"
              >
                <span className="text-ink">
                  {application.firstName} {application.lastName ?? ""}
                </span>
                <span className="flex items-center gap-2">
                  {application.rejectedReason ? (
                    <span className="text-xs text-ink-3">{application.rejectedReason}</span>
                  ) : null}
                  <Pill tone={application.status === "activated" ? "good" : "neutral"}>
                    {application.status}
                  </Pill>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Card({ application, score }: { application: ApplicationRow; score: number }) {
  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium text-ink">
            {application.firstName} {application.lastName ?? ""}
            <span className="nums ml-2 text-sm text-ink-3">{score}/100</span>
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            {[formatPhone(application.phone), application.email].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-1 flex flex-wrap gap-1.5">
            {application.yearsExperience !== null ? (
              <Pill>{application.yearsExperience} yrs</Pill>
            ) : null}
            <Pill tone={application.hasVehicle ? "good" : "warn"}>
              {application.hasVehicle ? "has transport" : "no transport"}
            </Pill>
            <Pill tone={application.workAuthorized ? "good" : "bad"}>
              {application.workAuthorized ? "authorised" : "not authorised"}
            </Pill>
            <Pill tone={application.hasOwnInsurance ? "good" : "warn"}>
              {application.hasOwnInsurance ? "insured" : "no insurance"}
            </Pill>
            {application.serviceZips.length > 0 ? (
              <Pill tone="sky">{application.serviceZips.join(" ")}</Pill>
            ) : (
              <Pill tone="warn">no service area</Pill>
            )}
          </p>
        </div>
        <div className="text-right">
          <Pill tone="sky">{application.status}</Pill>
          <p className="mt-1 text-xs text-ink-3">{formatDateInZone(application.submittedAt)}</p>
        </div>
      </div>

      {application.screenAnswers ? (
        <dl className="mt-3 space-y-2 border-t border-line pt-3">
          {SCREEN_QUESTIONS.map((question) => {
            const answer = application.screenAnswers?.[question.key];
            if (!answer) return null;
            return (
              <div key={question.key}>
                <dt className="text-xs text-ink-3">{question.prompt}</dt>
                <dd className="mt-0.5 text-sm whitespace-pre-wrap text-ink">{answer}</dd>
              </div>
            );
          })}
        </dl>
      ) : null}

      <div className="mt-3 border-t border-line pt-3">
        <ApplicationActions
          id={application.id}
          status={application.status}
          hasInsuranceDate={Boolean(application.insuranceExpiresOn)}
        />
      </div>
    </li>
  );
}

/** The score, if nobody has recorded one yet. */
function computed(application: ApplicationRow): number {
  return screenScore({
    yearsExperience: application.yearsExperience,
    hasVehicle: application.hasVehicle,
    workAuthorized: application.workAuthorized,
    hasOwnInsurance: application.hasOwnInsurance,
    serviceZips: application.serviceZips,
    answers: application.screenAnswers,
  });
}

/**
 * Read as the signed-in admin. An application is somebody's employment history,
 * their phone number and their right-to-work answer; `0003`'s admin policy is
 * the only thing that opens it, and nothing else should.
 */
async function load(): Promise<ApplicationRow[]> {
  const db = await createClient();

  const { data, error } = await db
    .from("applications")
    .select(
      "id, first_name, last_name, email, phone, status, years_experience, has_vehicle, " +
        "work_authorized, has_own_insurance, insurance_expires_on, service_zips, " +
        "screen_answers, screen_score, rejected_reason, cleaner_id, submitted_at",
    )
    .order("submitted_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`applications: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row["id"]),
    firstName: typeof row["first_name"] === "string" ? row["first_name"] : "",
    lastName: typeof row["last_name"] === "string" ? row["last_name"] : null,
    email: typeof row["email"] === "string" ? row["email"] : null,
    phone: typeof row["phone"] === "string" ? row["phone"] : null,
    status: String(row["status"]),
    yearsExperience: row["years_experience"] === null ? null : Number(row["years_experience"]),
    hasVehicle: typeof row["has_vehicle"] === "boolean" ? row["has_vehicle"] : null,
    workAuthorized: typeof row["work_authorized"] === "boolean" ? row["work_authorized"] : null,
    hasOwnInsurance:
      typeof row["has_own_insurance"] === "boolean" ? row["has_own_insurance"] : null,
    insuranceExpiresOn:
      typeof row["insurance_expires_on"] === "string" ? row["insurance_expires_on"] : null,
    serviceZips: Array.isArray(row["service_zips"]) ? (row["service_zips"] as string[]) : [],
    screenAnswers:
      row["screen_answers"] && typeof row["screen_answers"] === "object"
        ? (row["screen_answers"] as Record<string, string>)
        : null,
    screenScore: row["screen_score"] === null ? null : Number(row["screen_score"]),
    rejectedReason: typeof row["rejected_reason"] === "string" ? row["rejected_reason"] : null,
    cleanerId: typeof row["cleaner_id"] === "string" ? row["cleaner_id"] : null,
    submittedAt: new Date(String(row["submitted_at"])),
  }));
}
