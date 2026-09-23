"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Magic-link sign-in. No password to leak, reset, or store — which for a team
 * of two plus a cleaner roster is the right trade.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const [retryAt, setRetryAt] = useState(0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    if (Date.now() < retryAt) {
      setMessage("Please wait a minute before requesting another link.");
      return;
    }
    setMessage("");
    setState("sending");
    try {
      // Keep the allowed email callback fixed. Query-specific callbacks can fall
      // back to Supabase Site URL when the production allowlist is exact.
      document.cookie = `hs_login_next=${encodeURIComponent(next)}; Path=/auth; Max-Age=3600; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      setRetryAt(Date.now() + 60_000);
      setState("sent");
    } catch (err) {
      setState("error");
      setMessage(
        err instanceof Error ? err.message : "Could not send the link.",
      );
    }
  }

  if (state === "sent") {
    return (
      <div className="card p-6">
        <p className="eyebrow">Check your email</p>
        <p className="mt-2 text-sm text-ink-2">
          A sign-in link is on its way to{" "}
          <strong className="text-ink">{email}</strong>. Open the newest link in
          this same browser on this device to finish signing in.
        </p>
        <p className="mt-3 text-sm text-ink-2">
          Check spam or junk if it hasn’t arrived. If it still doesn’t arrive,
          email delivery may need attention from our team.
        </p>
        <button
          type="button"
          className="secondary-action mt-4"
          onClick={() => {
            setState("idle");
            setMessage("");
          }}
        >
          Try again or change email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card p-6">
      <label className="block">
        <span className="eyebrow">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@heyspotless.com"
          className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-sky-deep focus:outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={state === "sending"}
        className="mt-4 w-full rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-navy-deep disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>

      {message ? (
        <p role="alert" className="mt-3 text-sm text-bad">
          {message}
        </p>
      ) : null}
    </form>
  );
}
