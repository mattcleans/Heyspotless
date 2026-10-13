"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function ReleaseBackupForm({
  jobId,
  assignmentId,
  preferredCleanerId,
  backupCleanerId,
  decisionId,
}: {
  jobId: string;
  assignmentId: string;
  preferredCleanerId: string;
  backupCleanerId: string;
  decisionId: string;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [needsSignIn, setNeedsSignIn] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  async function release() {
    if (busy || saved) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/visits/${jobId}/release-backup`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            assignmentId,
            preferredCleanerId,
            backupCleanerId,
            decisionId,
          }),
        },
      );
      const data = await response.json().catch(() => null);
      if (response.status === 401) setNeedsSignIn(true);
      if (!response.ok || data?.released !== true)
        throw new Error(
          typeof data?.error === "string"
            ? data.error
            : "Release could not be confirmed. Refresh to check the assignment.",
        );
      setSaved(true);
      setMessage("Declined backup released. Normal matching can resume.");
      router.refresh();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Release failed. Refresh and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3">
      <p className="text-sm text-ink-2">
        Release removes this unstarted assignment and returns the visit to
        matching. This cleaner stays excluded from this visit. A different
        backup still needs client approval.
      </p>
      <button
        className="secondary-action mt-3"
        disabled={busy || saved || needsSignIn}
        onClick={() => void release()}
      >
        {busy ? "Releasing…" : "Release declined backup for matching"}
      </button>
      {needsSignIn && (
        <Link
          className="secondary-action mt-3 inline-flex"
          href="/login?next=%2Fadmin%2Fcleaner-requests"
        >
          Sign in to continue
        </Link>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
