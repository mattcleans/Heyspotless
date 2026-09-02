"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Magic-link sign-in. No password to leak, reset, or store — which for a team
 * of two plus a cleaner roster is the right trade.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw error;
      setState("sent");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Could not send the link.");
    }
  }

  if (state === "sent") {
    return (
      <div className="card p-6">
        <p className="eyebrow">Check your email</p>
        <p className="mt-2 text-sm text-ink-2">
          A sign-in link is on its way to <strong className="text-ink">{email}</strong>. It expires
          in an hour.
        </p>
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

      {state === "error" ? <p className="mt-3 text-sm text-bad">{message}</p> : null}
    </form>
  );
}
