"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The reply box.
 *
 * Deliberately plain: a textarea and a button. The office is answering a text
 * message, and every affordance that is not "type the thing and send it" is one
 * more thing between a customer's question and its answer.
 *
 * The recipient is not in this component's hands — it posts the thread's ids
 * and the server reads the number off the record. A `to` the browser can set is
 * a way to send an SMS from the business's registered number to anywhere.
 */

interface Target {
  customerId?: string | null;
  cleanerId?: string | null;
  leadId?: string | null;
  phone?: string | null;
}

export function ReplyBox({ target, name }: { target: Target; name: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setState("sending");
    setError(null);

    try {
      const response = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, body: text.trim() }),
      });

      const payload: unknown = await response.json().catch(() => ({}));
      const data = (payload ?? {}) as { error?: unknown; reason?: unknown };

      if (!response.ok) {
        setState("failed");
        setError(
          typeof data.error === "string"
            ? data.error
            : typeof data.reason === "string"
              ? data.reason
              : "That did not send.",
        );
        return;
      }

      // Cleared only once it is actually away. A box that empties on a failed
      // send has thrown away what somebody wrote.
      setText("");
      setState("idle");
      router.refresh();
    } catch {
      setState("failed");
      setError("No connection. Nothing was sent.");
    }
  }

  return (
    <div className="border-t border-line p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={1200}
        placeholder={`Reply to ${name}`}
        className="w-full rounded-lg border border-line bg-surface-2 p-3 text-sm"
        onKeyDown={(e) => {
          // Enter sends, shift-enter breaks the line — the convention every
          // messaging app has trained everyone into.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-3">
          {error ? <span className="text-bad">{error}</span> : `${text.length}/1200`}
        </p>
        <button
          type="button"
          onClick={() => void send()}
          disabled={state === "sending" || !text.trim()}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-deep disabled:opacity-40"
        >
          {state === "sending" ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
