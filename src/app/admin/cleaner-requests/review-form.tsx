"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function ReviewChoiceForm({
  id,
  canApply,
  preview = false,
}: {
  id: string;
  canApply: boolean;
  preview?: boolean;
}) {
  const router = useRouter(),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [needsSignIn, setNeedsSignIn] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  async function save(apply: boolean) {
    if (busy || saved || preview || !note.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/cleaner-requests/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply, note }),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 401) setNeedsSignIn(true);
      if (!response.ok || data?.saved !== true)
        throw new Error(
          typeof data?.error === "string"
            ? data.error
            : "The review could not be confirmed. Your explanation is still here.",
        );
      setSaved(true);
      setMessage("Review recorded.");
      router.refresh();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Could not record the review. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4">
      <label htmlFor={`review-${id}`} className="text-sm">
        Explanation for the client
      </label>
      <textarea
        id={`review-${id}`}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
        className="mt-2 block min-h-24 w-full rounded-lg border border-line bg-white px-3 py-2 text-base"
      />
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          className="primary-action"
          disabled={
            busy || saved || needsSignIn || preview || !canApply || !note.trim()
          }
          onClick={() => void save(true)}
        >
          {busy ? "Saving…" : "Apply to matching"}
        </button>
        <button
          className="secondary-action"
          disabled={busy || saved || needsSignIn || preview || !note.trim()}
          onClick={() => void save(false)}
        >
          Decline request
        </button>
      </div>
      {!canApply && (
        <p className="mt-2 text-sm text-ink-2">
          Resolve the current assignment or closed visit before applying a
          preference.
        </p>
      )}
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
