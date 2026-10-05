import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
export interface ChoiceRequest {
  id: string;
  cleanerId: string;
  cleanerName: string;
  status: string;
  note: string;
  decisionNote: string | null;
}
export interface BackupChoice {
  assignmentId: string;
  preferredCleanerId: string;
  backupCleanerId: string;
  preferredName: string;
  backupName: string;
  approved: boolean;
  decisionId: string | null;
  note: string;
  unambiguous: boolean;
}
export interface VisitChoice {
  status: string;
  started: boolean;
  preferredCleanerId: string | null;
  assigned: { id: string; cleanerId: string; name: string } | null;
  request: ChoiceRequest | null;
  backup: BackupChoice | null;
}
const fail = () =>
  new Error("Cleaner choices could not be loaded. Refresh or call the office.");
const text = (v: unknown): string => {
  if (typeof v !== "string") throw fail();
  return v;
};
const nullable = (v: unknown): string | null => (v === null ? null : text(v));
export async function loadVisitChoice(
  db: SupabaseClient,
  id: string,
): Promise<VisitChoice | null> {
  const job = await db
    .from("jobs")
    .select("status,started_at,preferred_cleaner_id")
    .eq("id", id)
    .maybeSingle();
  if (job.error) throw fail();
  if (!job.data) return null;
  const [assignments, requests, backups] = await Promise.all([
    db
      .from("client_visit_assignments")
      .select("id,cleaner_id,full_name")
      .eq("job_id", id)
      .eq("is_lead", true)
      .order("assigned_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(2),
    db
      .from("visit_cleaner_requests")
      .select("id,cleaner_id,cleaner_name,status,note,decision_note")
      .eq("job_id", id)
      .order("version", { ascending: false })
      .limit(1),
    db
      .from("visit_backup_status")
      .select(
        "assignment_id,preferred_cleaner_id,backup_cleaner_id,preferred_name,backup_name,approved,decision_id,unambiguous",
      )
      .eq("job_id", id)
      .limit(2),
  ]);
  for (const result of [assignments, requests, backups])
    if (result.error || !Array.isArray(result.data)) throw fail();
  if (assignments.data!.length > 1 || backups.data!.length > 1)
    throw new Error(
      "Your cleaner assignment needs office review before a choice can be confirmed.",
    );
  const a = assignments.data![0],
    r = requests.data![0],
    b = backups.data![0];
  const startedAt = nullable(job.data.started_at);
  if (startedAt !== null && !Number.isFinite(Date.parse(startedAt)))
    throw fail();
  if (
    b &&
    (typeof b.approved !== "boolean" || typeof b.unambiguous !== "boolean")
  )
    throw fail();
  const decisionId = b ? nullable(b.decision_id) : null;
  let backupNote = "";
  if (b && decisionId !== null) {
    const decision = await db
      .from("visit_backup_decisions")
      .select("note")
      .eq("id", decisionId)
      .eq("job_id", id)
      .eq("assignment_key", text(b.assignment_id))
      .eq("preferred_cleaner_id", text(b.preferred_cleaner_id))
      .eq("backup_cleaner_id", text(b.backup_cleaner_id))
      .maybeSingle();
    if (decision.error || !decision.data) throw fail();
    backupNote = text(decision.data.note);
  }
  return {
    status: text(job.data.status),
    started: startedAt !== null,
    preferredCleanerId: nullable(job.data.preferred_cleaner_id),
    assigned: a
      ? {
          id: text(a.id),
          cleanerId: text(a.cleaner_id),
          name: text(a.full_name),
        }
      : null,
    request: r
      ? {
          id: text(r.id),
          cleanerId: text(r.cleaner_id),
          cleanerName: text(r.cleaner_name),
          status: text(r.status),
          note: text(r.note),
          decisionNote: nullable(r.decision_note),
        }
      : null,
    backup: b
      ? {
          assignmentId: text(b.assignment_id),
          preferredCleanerId: text(b.preferred_cleaner_id),
          backupCleanerId: text(b.backup_cleaner_id),
          preferredName: text(b.preferred_name),
          backupName: text(b.backup_name),
          approved: b.approved,
          decisionId,
          note: backupNote,
          unambiguous: b.unambiguous,
        }
      : null,
  };
}
export async function listChoiceReview(db: SupabaseClient) {
  const [requests, backups] = await Promise.all([
    db
      .from("visit_cleaner_requests")
      .select(
        "id,job_id,cleaner_name,note,jobs(status,customers(first_name,last_name),properties(street,city))",
      )
      .eq("status", "pending")
      .order("version", { ascending: true })
      .limit(200),
    db
      .from("visit_backup_status")
      .select(
        "job_id,customer_name,street,city,backup_name,preferred_name,assignment_id,preferred_cleaner_id,backup_cleaner_id,decision_id,unambiguous,release_allowed",
      )
      .eq("job_status", "assigned")
      .is("started_at", null)
      .eq("approved", false)
      .order("job_id", { ascending: true })
      .limit(200),
  ]);
  if (
    requests.error ||
    backups.error ||
    !Array.isArray(requests.data) ||
    !Array.isArray(backups.data)
  )
    throw fail();
  const decisionIds = backups.data.flatMap((b) =>
    typeof b.decision_id === "string" ? [b.decision_id] : [],
  );
  const notes = decisionIds.length
    ? await db
        .from("visit_backup_decisions")
        .select("id,note")
        .in("id", decisionIds)
        .limit(200)
    : { data: [], error: null };
  if (notes.error || !Array.isArray(notes.data)) throw fail();
  const relation = (value: unknown): Record<string, unknown> => {
    const row = Array.isArray(value) ? value[0] : value;
    if (!row || typeof row !== "object") throw fail();
    return row as Record<string, unknown>;
  };
  return {
    requests: requests.data.map((r) => {
      const j = relation(r.jobs),
        c = relation(j.customers),
        p = relation(j.properties);
      return {
        id: text(r.id),
        jobId: text(r.job_id),
        cleanerName: text(r.cleaner_name),
        note: text(r.note),
        customerName: `${text(c.first_name)} ${text(c.last_name)}`,
        address: `${text(p.street)}, ${text(p.city)}`,
        canApply: ["unscheduled", "scheduled", "dispatching"].includes(
          text(j.status),
        ),
      };
    }),
    backups: backups.data.map((b) => ({
      jobId: text(b.job_id),
      customerName: text(b.customer_name),
      address: `${text(b.street)}, ${text(b.city)}`,
      backupName: text(b.backup_name),
      preferredName: text(b.preferred_name),
      assignmentId: text(b.assignment_id),
      preferredCleanerId: text(b.preferred_cleaner_id),
      backupCleanerId: text(b.backup_cleaner_id),
      decisionId: nullable(b.decision_id),
      clientNote: notes.data!.find((n) => n.id === b.decision_id)?.note as
        string | undefined,
      declined: b.decision_id !== null,
      unambiguous: b.unambiguous === true,
      canRelease: b.release_allowed === true,
    })),
  };
}
