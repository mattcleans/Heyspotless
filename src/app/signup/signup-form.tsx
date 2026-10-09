"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { continueAfterSignIn, loginDestinationCookie, passwordIssue } from "@/lib/auth/password";
const next = "/customer/account/homes/new";
const field = "mt-2 min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-base";
export function SignupForm({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [show, setShow] = useState(false), [state, setState] = useState<"idle" | "sending" | "sent">("idle"), [error, setError] = useState("");
  const sending = useRef(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (sending.current || demo) return;
    const issue = passwordIssue(password, confirmation); if (issue) { setError(issue); return; }
    sending.current = true; setState("sending"); setError("");
    try {
      document.cookie = loginDestinationCookie(next, window.location.protocol === "https:");
      const { data, error: problem } = await createClient().auth.signUp({ email: email.trim(), password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
      if (problem) {
        if (["user_already_exists", "email_exists"].includes(problem.code ?? "")) { setPassword(""); setConfirmation(""); setState("sent"); return; }
        setError(problem.code === "weak_password" ? "Choose a stronger password, with letters, numbers and symbols."
          : ["over_email_send_rate_limit", "over_request_rate_limit"].includes(problem.code ?? "") ? "Account emails are temporarily limited. Try again later, or call 469-280-0397 for help."
          : "We could not finish account setup. Try again shortly, or sign in if you already have an account.");
        setState("idle"); return;
      }
      setPassword(""); setConfirmation("");
      if (data.session) { window.location.assign(continueAfterSignIn(next)); return; }
      setState("sent");
    } catch { setError("We could not confirm account setup. Check your email, or sign in with your email and password before trying again."); setState("idle"); }
    finally { sending.current = false; }
  }
  if (state === "sent") return <section className="visit-feature" aria-live="polite">
    <h2 className="text-lg font-semibold text-navy">Check your email</h2>
    <p className="mt-3 text-sm text-ink-2">If this email is new, open the newest confirmation email in this browser on this device. Then add your home. If you already have an account, sign in with your existing password.</p>
    <p className="mt-3 text-sm text-ink-2">Check spam or junk. For help with email delivery, call <a href="tel:+14692800397" className="underline">469-280-0397</a>.</p>
    <Link href="/login?next=%2Fcustomer%2Faccount%2Fhomes%2Fnew" className="secondary-action mt-4 inline-flex">Sign in with your password</Link>
  </section>;
  return <form onSubmit={submit}>
    <label className="block text-sm font-semibold">Email<input type="email" autoComplete="email" required disabled={state === "sending" || demo} value={email} onChange={e => setEmail(e.target.value)} className={field} /></label>
    <label className="mt-4 block text-sm font-semibold">Password<input type={show ? "text" : "password"} autoComplete="new-password" minLength={8} required disabled={state === "sending" || demo} value={password} onChange={e => setPassword(e.target.value)} className={field} /></label>
    <p className="mt-2 text-sm text-ink-2">Use at least 8 characters.</p>
    <label className="mt-4 block text-sm font-semibold">Confirm password<input type={show ? "text" : "password"} autoComplete="new-password" minLength={8} required disabled={state === "sending" || demo} value={confirmation} onChange={e => setConfirmation(e.target.value)} className={field} /></label>
    <button type="button" aria-pressed={show} disabled={state === "sending"} onClick={() => setShow(!show)} className="min-h-11 text-sm text-navy underline">{show ? "Hide passwords" : "Show passwords"}</button>
    {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
    {demo && <p className="mt-3 text-sm text-ink-2">This sample preview does not create accounts.</p>}
    <button type="submit" disabled={state === "sending" || demo} className="primary-action mt-4 min-h-11 w-full">{state === "sending" ? "Creating account…" : "Create Client account"}</button>
  </form>;
}
