"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  continueAfterSignIn,
  loginDestinationCookie,
  passwordAuthError,
  passwordDestination,
} from "@/lib/auth/password";

export function LoginForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"password" | "email" | "reset">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const [retryAt, setRetryAt] = useState(0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    if (mode !== "password" && Date.now() < retryAt) {
      setMessage("Please wait a minute before requesting another email.");
      return;
    }
    setMessage("");
    setState("sending");
    try {
      const supabase = createClient();
      if (mode === "password") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) {
          setState("error");
          setMessage(passwordAuthError(error, "sign-in"));
          return;
        }
        setPassword("");
        // A real navigation lets the server verify the newly written session
        // cookies before routing by the saved profile role.
        window.location.assign(continueAfterSignIn(next));
        return;
      }
      // Recovery uses the same fixed allowed callback as optional email sign-in.
      document.cookie = loginDestinationCookie(
        mode === "reset" ? passwordDestination(next) : next,
        window.location.protocol === "https:",
      );
      const { error } =
        mode === "reset"
          ? await supabase.auth.resetPasswordForEmail(email.trim(), {
              redirectTo: `${window.location.origin}/auth/callback`,
            })
          : await supabase.auth.signInWithOtp({
              email: email.trim(),
              options: {
                emailRedirectTo: `${window.location.origin}/auth/callback`,
                shouldCreateUser: false,
              },
            });
      if (error) {
        setState("error");
        setMessage(passwordAuthError(error, "email"));
        return;
      }
      setRetryAt(Date.now() + 60_000);
      setState("sent");
    } catch {
      setState("error");
      setMessage(
        passwordAuthError(null, mode === "password" ? "sign-in" : "email"),
      );
    }
  }

  if (state === "sent") {
    return (
      <div className="card p-6">
        <p className="eyebrow">Check your email</p>
        <p className="mt-2 text-sm text-ink-2">
          {mode === "reset"
            ? "If this email has an account, a password reset link is on its way to "
            : "A sign-in link is on its way to "}
          <strong className="text-ink">{email}</strong>. Open the newest link in
          this same browser on this device to finish signing in.
        </p>
        {mode === "reset" && (
          <p className="mt-3 text-sm text-ink-2">
            Choose your password after opening the link. Next time, sign in with
            your email and password.
          </p>
        )}
        <p className="mt-3 text-sm text-ink-2">
          Check spam or junk if it hasn’t arrived. If it still doesn’t arrive,
          email delivery may need attention from our team.
        </p>
        <button
          type="button"
          className="secondary-action mt-4 min-h-11"
          onClick={() => {
            setState("idle");
            setMessage("");
          }}
        >
          Try again or change email
        </button>
        <button
          type="button"
          className="mt-3 block min-h-11 text-sm font-semibold text-navy underline"
          onClick={() => {
            setMode("password");
            setState("idle");
            setMessage("");
          }}
        >
          Back to password sign-in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card p-6">
      {mode === "reset" && (
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-navy">
            Set or reset your password
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            Enter your account email. We’ll send a link so you can choose a
            password.
          </p>
        </div>
      )}
      <label className="block">
        <span className="text-sm font-semibold text-ink">Email</span>
        <input
          type="email"
          required
          disabled={state === "sending"}
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@heyspotless.com"
          className="mt-1.5 min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-sky-deep focus:outline-none"
        />
      </label>
      {mode === "password" && (
        <div className="mt-4">
          <label className="block">
            <span className="text-sm font-semibold text-ink">Password</span>
            <input
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              disabled={state === "sending"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-sky-deep focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={state === "sending"}
            aria-pressed={showPassword}
            className="min-h-11 text-sm font-semibold text-navy underline"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? "Hide password" : "Show password"}
          </button>
        </div>
      )}

      <button
        type="submit"
        disabled={state === "sending"}
        className="mt-4 min-h-11 w-full rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-navy-deep disabled:opacity-60"
      >
        {state === "sending"
          ? mode === "password"
            ? "Signing in…"
            : "Sending…"
          : mode === "password"
            ? "Sign in"
            : mode === "reset"
              ? "Send password reset email"
              : "Email me a sign-in link"}
      </button>

      {message ? (
        <p role="alert" className="mt-3 text-sm text-bad">
          {message}
        </p>
      ) : null}
      <div className="mt-3 flex flex-col items-start">
        {mode === "password" ? (
          <>
            <button
              type="button"
              disabled={state === "sending"}
              className="min-h-11 text-sm font-semibold text-navy underline"
              onClick={() => {
                setMode("reset");
                setPassword("");
                setMessage("");
                setState("idle");
              }}
            >
              Set or reset password
            </button>
            <button
              type="button"
              disabled={state === "sending"}
              className="min-h-11 text-sm text-ink-2 underline"
              onClick={() => {
                setMode("email");
                setPassword("");
                setMessage("");
                setState("idle");
              }}
            >
              Use an email sign-in link instead
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={state === "sending"}
            className="min-h-11 text-sm font-semibold text-navy underline"
            onClick={() => {
              setMode("password");
              setMessage("");
              setState("idle");
            }}
          >
            Back to password sign-in
          </button>
        )}
      </div>
    </form>
  );
}
