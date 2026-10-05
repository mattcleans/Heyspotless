"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { VisitChoice } from "@/lib/customer/cleaner-choice/store";
export interface ChoicePerson {
  id: string;
  name: string;
}
export function CleanerChoiceForm({
  jobId,
  choice,
  people,
  selectedId,
  preview = false,
}: {
  jobId: string;
  choice: VisitChoice;
  people: ChoicePerson[];
  selectedId?: string;
  preview?: boolean;
}) {
  const router = useRouter();
  const [cleanerId, setCleanerId] = useState(
    people.some((p) => p.id === selectedId)
      ? selectedId!
      : people.some((p) => p.id === choice.request?.cleanerId)
        ? choice.request!.cleanerId
        : "",
  );
  const [note, setNote] = useState("");
  const [backupNote, setBackupNote] = useState(choice.backup?.note ?? "");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null),
    [needsSignIn, setNeedsSignIn] = useState(false),
    [conflict, setConflict] = useState(false);
  const key = useRef<{ signature: string; id: string } | null>(null);
  const closed =
    choice.started ||
    ["in_progress", "complete", "canceled"].includes(choice.status);
  async function save(kind: "request" | "backup", accept?: boolean) {
    if (preview || busy || closed || conflict) return;
    const backup = choice.backup;
    const payload =
      kind === "request"
        ? { cleanerId, note, expectedLatest: choice.request?.id ?? null }
        : {
            assignmentId: backup?.assignmentId,
            preferredCleanerId: backup?.preferredCleanerId,
            backupCleanerId: backup?.backupCleanerId,
            accept,
            note: backupNote,
            expectedLatest: backup?.decisionId ?? null,
          };
    const signature = JSON.stringify({ kind, ...payload });
    if (key.current?.signature !== signature)
      key.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    setMessage(null);
    setNeedsSignIn(false);
    try {
      const response = await fetch(
        `/api/customer/visits/${jobId}/${kind === "request" ? "cleaner-request" : "backup"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, id: key.current.id }),
        },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.saved !== true) {
        setNeedsSignIn(response.status === 401);
        setConflict(response.status === 409);
        throw new Error(
          typeof data?.error === "string"
            ? data.error
            : "We could not confirm the save. Your choice is still here.",
        );
      }
      setMessage(
        kind === "request"
          ? data.status === "pending"
            ? "Request saved for office review. Your cleaner is not confirmed yet."
            : "This request was already recorded. Refresh to see its latest outcome."
          : data.accepted === true
            ? "Your approval was recorded for the assignment you reviewed. Refresh to check the current cleaner."
            : "Your request for a different cleaner was recorded. Work cannot start with this backup until you approve it. Contact the office to arrange the change.",
      );
      setConflict(true);
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not save. Your choice is still here. Try again or call the office.",
      );
    } finally {
      setBusy(false);
    }
  }
  function reload() {
    window.location.reload();
  }
  const backup = choice.backup;
  return (
    <>
      {backup && (
        <section
          className="visit-feature mt-4"
          aria-labelledby="backup-heading"
        >
          <h2 id="backup-heading" className="font-semibold text-navy">
            {backup.approved
              ? "Your approved backup"
              : backup.decisionId
                ? "You asked for a different cleaner"
                : "Review your backup cleaner"}
          </h2>
          <p className="mt-2 text-sm">
            {backup.backupName} is assigned in place of {backup.preferredName}.
          </p>
          <p className="mt-2 text-sm text-ink-2">
            {backup.approved
              ? "You approved this specific assignment. A different cleaner will need a new approval."
              : closed
                ? "No client approval is recorded for this assignment. Call the office if you need help."
                : backup.decisionId
                  ? "The office needs to arrange a different cleaner. Work cannot start with this backup unless you change your decision and approve them."
                  : "This backup cannot start work until you approve the assignment. You can ask the office to arrange a different cleaner."}
          </p>
          {!closed && backup.unambiguous && (
            <>
              <label className="mt-4 block text-sm" htmlFor="backup-note">
                Note for the office (optional)
              </label>
              <textarea
                id="backup-note"
                maxLength={500}
                value={backupNote}
                onChange={(e) => setBackupNote(e.target.value)}
                disabled={busy}
                className="mt-2 block min-h-24 w-full rounded-lg border border-line bg-white px-3 py-2 text-base"
              />
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  className="primary-action"
                  disabled={busy || preview || conflict}
                  onClick={() => void save("backup", true)}
                >
                  {busy
                    ? "Saving…"
                    : backup.approved
                      ? "Keep this backup"
                      : backup.decisionId
                        ? "Approve this backup instead"
                        : "Approve this backup"}
                </button>
                <button
                  className="secondary-action"
                  disabled={busy || preview || conflict}
                  onClick={() => void save("backup", false)}
                >
                  Ask for a different cleaner
                </button>
              </div>
            </>
          )}
          {!backup.unambiguous && (
            <p className="mt-3 text-sm">
              The assignment needs office review before you can approve it.
            </p>
          )}
        </section>
      )}
      {choice.assigned && !backup && (
        <section className="visit-feature mt-4">
          <h2 className="font-semibold text-navy">Current assignment</h2>
          <p className="mt-2">{choice.assigned.name}</p>
          <p className="mt-2 text-sm text-ink-2">
            A preference request does not replace this assignment. The office
            must review any change.
          </p>
        </section>
      )}
      {choice.request && (
        <section className="visit-feature mt-4">
          <h2 className="font-semibold text-navy">Your latest request</h2>
          <p className="mt-2">{choice.request.cleanerName}</p>
          <p className="mt-2 text-sm text-ink-2">
            {choice.request.status === "pending"
              ? "Waiting for office review. The requested cleaner is not confirmed."
              : choice.request.status === "applied"
                ? choice.assigned?.cleanerId === choice.request.cleanerId
                  ? "Your preferred cleaner is assigned to this visit."
                  : "Preference applied to matching. This does not confirm that the requested cleaner has accepted the visit."
                : choice.request.status === "declined"
                  ? "The office could not apply this request."
                  : "This request was replaced by a newer choice."}
          </p>
          {choice.request.note && (
            <p className="mt-2 whitespace-pre-wrap text-sm">
              Your note: {choice.request.note}
            </p>
          )}
          {choice.request.decisionNote && (
            <p className="mt-2 whitespace-pre-wrap text-sm">
              {choice.request.decisionNote}
            </p>
          )}
        </section>
      )}
      {closed ? (
        <p className="visit-feature mt-4">
          Cleaner choices are closed for a started, finished or canceled visit.
          Call the office if you need help.
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("request");
          }}
          className="visit-feature mt-5"
        >
          <h2 className="font-semibold text-navy">
            Request a preferred cleaner
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            Choose who you would like for this visit. The office checks the
            request, then the cleaner must be assigned through matching. If a
            backup is needed, you approve them before work starts.
          </p>
          <label htmlFor="preferred-cleaner" className="mt-4 block text-sm">
            Preferred cleaner
          </label>
          <select
            id="preferred-cleaner"
            required
            value={cleanerId}
            onChange={(e) => setCleanerId(e.target.value)}
            disabled={busy}
            className="mt-2 block min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-base"
          >
            <option value="">Choose a cleaner</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-ink-3">
            {preview
              ? "Sample cleaner choices. These do not confirm service coverage or availability."
              : "Showing up to 24 published profiles serving this home’s ZIP code. This list does not confirm availability for your appointment."}
          </p>
          <label htmlFor="cleaner-note" className="mt-4 block text-sm">
            Note for the office (optional)
          </label>
          <textarea
            id="cleaner-note"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            className="mt-2 block min-h-24 w-full rounded-lg border border-line bg-white px-3 py-2 text-base"
          />
          <button
            className="primary-action mt-4"
            type="submit"
            disabled={busy || preview || conflict || !cleanerId}
          >
            {busy ? "Saving…" : "Send preference request"}
          </button>
          {!people.length && (
            <p className="mt-3 text-sm">
              No published profiles were found for this home. Call the office to
              discuss matching.
            </p>
          )}
        </form>
      )}
      {preview && (
        <p className="preview-note mt-4 rounded-lg">
          Sample choices only. Requests and approvals cannot be saved in preview
          mode.
        </p>
      )}
      {message && (
        <p role="status" className="visit-feature mt-4">
          {message}
        </p>
      )}
      {needsSignIn && (
        <Link
          className="secondary-action mt-3 inline-flex"
          href={`/login?next=${encodeURIComponent(`/customer/visits/${jobId}/cleaner`)}`}
        >
          Sign in again
        </Link>
      )}
      <p className="mt-5 text-sm text-ink-2">
        Refresh replaces this form with the latest records. Your unsaved choices
        will be cleared.
      </p>
      <button
        onClick={reload}
        className="secondary-action mt-2"
        disabled={busy}
      >
        Refresh cleaner choices
      </button>
      <p className="mt-5 text-sm">
        <a
          href="tel:+14692800397"
          className="inline-flex min-h-11 items-center underline"
        >
          Call the office
        </a>{" "}
        for help with a request or backup.
      </p>
    </>
  );
}
