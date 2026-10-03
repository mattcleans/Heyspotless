"use client";
import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  continueAfterSignIn,
  passwordAuthError,
  passwordIssue,
  saveOwnPassword,
} from "@/lib/auth/password";

export function PasswordForm({
  ownerId,
  next,
}: {
  ownerId: string;
  next: string;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const issue = passwordIssue(password, confirmation);
    if (issue) {
      setMessage(issue);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const db = createClient();
      const error = await saveOwnPassword(
        db.auth,
        ownerId,
        password,
        confirmation,
      );
      if (error) {
        setMessage(error);
        return;
      }
      setPassword("");
      setConfirmation("");
      setShow(false);
      setSaved(true);
    } catch {
      setMessage(passwordAuthError(null, "save"));
    } finally {
      setBusy(false);
    }
  }
  if (saved)
    return (
      <section className="card p-6">
        <h2 role="status" className="text-lg font-semibold text-navy">
          Password saved
        </h2>
        <p className="mt-2 text-sm text-ink-2">
          Next time, sign in with your email and this password.
        </p>
        <Link
          href={continueAfterSignIn(next)}
          prefetch={false}
          className="secondary-action mt-5 min-h-11"
        >
          Continue to your workspace
        </Link>
      </section>
    );
  const inputClass =
    "mt-1.5 min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-sky-deep focus:outline-none";
  return (
    <form onSubmit={submit} className="card p-6">
      <label className="block">
        <span className="text-sm font-semibold text-ink">New password</span>
        <input
          type={show ? "text" : "password"}
          autoComplete="new-password"
          required
          minLength={8}
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="password-help"
          className={inputClass}
        />
      </label>
      <p id="password-help" className="mt-2 text-sm text-ink-2">
        Use at least 8 characters. A longer, unique passphrase is easier to
        remember.
      </p>
      <label className="mt-4 block">
        <span className="text-sm font-semibold text-ink">
          Confirm new password
        </span>
        <input
          type={show ? "text" : "password"}
          autoComplete="new-password"
          required
          minLength={8}
          disabled={busy}
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          className={inputClass}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        aria-pressed={show}
        className="min-h-11 text-sm font-semibold text-navy underline"
        onClick={() => setShow(!show)}
      >
        {show ? "Hide passwords" : "Show passwords"}
      </button>
      {message && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {message}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="mt-4 min-h-11 w-full rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-navy-deep disabled:opacity-60"
      >
        {busy ? "Saving…" : "Save password"}
      </button>
      <Link
        href={continueAfterSignIn(next)}
        prefetch={false}
        className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-navy underline"
      >
        Back to your workspace
      </Link>
    </form>
  );
}
