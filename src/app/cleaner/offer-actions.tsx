"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * Accept or decline, from the cleaner's phone.
 *
 * Two things this deliberately does NOT send: who is answering, and what the
 * job pays. The first comes from the session on the server, because an offer
 * id in a request body is otherwise a way to answer somebody else's offer. The
 * second is read off the offer row inside `respond_to_offer` — an accept
 * endpoint that took an amount would hand back exactly the permission 0007
 * removed.
 *
 * Every outcome that is not "yours" is still an ordinary thing that happens,
 * so each one gets a sentence written for the person holding the phone. Losing
 * a race is the commonest of them and must never read as her mistake.
 */

type State =
  | { status: "idle" }
  | { status: "working"; accepting: boolean }
  | { status: "error"; message: string; signIn?: boolean }
  | { status: "settled"; tone: "good" | "plain"; message: string };

export function OfferActions({ offerId }: { offerId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function respond(accept: boolean) {
    setState({ status: "working", accepting: accept });

    try {
      const response = await fetch("/api/dispatch/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offerId, accept }),
      });

      const payload: unknown = await response.json().catch(() => ({}));
      const data = (payload ?? {}) as { outcome?: unknown; message?: unknown; error?: unknown };

      if (typeof data.outcome !== "string" || !["accepted", "declined", "taken", "expired", "superseded", "not_found"].includes(data.outcome)) {
        setState({ status: "error", signIn: response.status === 401, message: response.status === 401
          ? "Your session has ended. Sign in again to answer this offer."
          : "We couldn’t confirm your answer. Try again, or call the office for help." });
        return;
      }

      const message =
        typeof data.message === "string"
          ? data.message
          : typeof data.error === "string"
            ? data.error
            : "Something went wrong. Try again.";

      setState({
        status: "settled",
        tone: data.outcome === "accepted" ? "good" : "plain",
        message,
      });
      router.refresh();
    } catch {
      // A cleaner is often standing in someone's kitchen with one bar of
      // signal. "Try again" is the truth and is actionable; a stack trace is
      // neither.
      setState({
        status: "error",
        message: "We couldn’t confirm your answer. Check your connection and try again.",
      });
    }
  }

  if (state.status === "settled") {
    return (
      <p
        className={`mt-3 text-sm ${state.tone === "good" ? "text-navy" : "text-ink-2"}`}
        role="status"
      >
        {state.message}
      </p>
    );
  }

  const working = state.status === "working";

  return (
    <div className="mt-3">
      {state.status === "error" && <p role="alert" className="mb-3 text-sm text-ink-2">{state.message}</p>}
      {state.status === "error" && state.signIn && <Link href="/login?next=%2Fcleaner" className="secondary-action mb-3">Sign in again</Link>}
      <div className="flex gap-2">
      <button
        type="button"
        onClick={() => void respond(true)}
        disabled={working}
        className="flex-1 rounded-lg bg-navy px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {working && state.accepting ? "Booking…" : "Accept"}
      </button>
      <button
        type="button"
        onClick={() => void respond(false)}
        disabled={working}
        className="rounded-lg border border-line px-4 py-2.5 text-sm text-ink-2 disabled:opacity-60"
      >
        {working && !state.accepting ? "…" : "Pass"}
      </button>
      </div>
    </div>
  );
}
