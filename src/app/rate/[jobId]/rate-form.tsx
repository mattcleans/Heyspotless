"use client";

import { useState } from "react";

/**
 * Five stars and a box, on a phone, from a text message.
 *
 * THE RATING IS SENT ON THE TAP. Not on a submit button below a comment field —
 * most people tap a star and put the phone down, and a design that only records
 * the ones who also write a sentence throws away most of the data the
 * eligibility gate exists to use. The comment is a second, optional write.
 *
 * Nothing on this page says who the customer is or what they paid: the link
 * arrives by SMS and SMS gets forwarded.
 */

type State =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; score: number }
  | { status: "failed"; message: string };

const FACES: Record<number, string> = {
  1: "Not good",
  2: "Below par",
  3: "Fine",
  4: "Good",
  5: "Excellent",
};

export function RateForm({ jobId, alreadyRated }: { jobId: string; alreadyRated: boolean }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [comment, setComment] = useState("");
  const [commentSaved, setCommentSaved] = useState(false);

  const score = state.status === "saved" ? state.score : null;

  async function send(nextScore: number, withComment: string | null) {
    setState({ status: "saving" });
    try {
      const response = await fetch("/api/ratings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, score: nextScore, comment: withComment }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => ({}));
        const data = (payload ?? {}) as { error?: unknown };
        setState({
          status: "failed",
          message: typeof data.error === "string" ? data.error : "That did not save.",
        });
        return;
      }

      setState({ status: "saved", score: nextScore });
      if (withComment) setCommentSaved(true);
    } catch {
      setState({ status: "failed", message: "No connection. Nothing was sent — try again." });
    }
  }

  return (
    <div className="card p-5">
      {alreadyRated && state.status === "idle" ? (
        <p className="mb-3 text-sm text-ink-2">
          You have rated this clean already. Tapping again replaces what you said.
        </p>
      ) : null}

      <div className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} out of 5 — ${FACES[n]}`}
            disabled={state.status === "saving"}
            onClick={() => void send(n, comment.trim() || null)}
            className={`flex-1 rounded-lg border py-4 text-2xl transition-colors ${
              score !== null && n <= score
                ? "border-sky-deep bg-sky/20"
                : "border-line bg-surface-2 hover:border-sky-deep"
            }`}
          >
            {score !== null && n <= score ? "★" : "☆"}
          </button>
        ))}
      </div>

      {score !== null ? (
        <p className="mt-2 text-center text-sm font-medium text-navy">{FACES[score]}</p>
      ) : (
        <p className="mt-2 text-center text-sm text-ink-3">Tap a star</p>
      )}

      {state.status === "failed" ? (
        <p className="mt-3 text-sm text-bad">{state.message}</p>
      ) : null}

      {state.status === "saved" ? (
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-sm text-ink-2">
            {commentSaved
              ? "Thank you — that is with the office."
              : "Thank you. Anything you want us to know?"}
          </p>

          {!commentSaved ? (
            <>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Optional"
                className="mt-2 w-full rounded-lg border border-line bg-surface-2 p-3 text-sm"
              />
              <button
                type="button"
                disabled={!comment.trim()}
                onClick={() => void send(state.score, comment.trim())}
                className="mt-2 rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
              >
                Send
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
