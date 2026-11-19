"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";
import { parseRefundDollars, REFUND_CHOICES, refundChoice } from "@/lib/billing/refund-options";

interface Props {
  paymentIntentId: string;
  refundableCents: number;
  customerName: string;
}

type Result = { message: string; ok: boolean; retrySafe?: boolean };

/**
 * Send money back to a client's card. The reason is required and has no
 * default, because it decides whether the client owes the money again.
 *
 * One request id per form. A repeated click, or a retry after Stripe did not
 * answer, reuses it, so Stripe refunds once. The id is replaced only after a
 * definite answer, which makes a second refund a deliberate new form.
 */
export function RefundAction({ paymentIntentId, refundableCents, customerName }: Props) {
  const router = useRouter();
  const locked = useRef(false);
  const requestId = useRef<string>(crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((refundableCents / 100).toFixed(2));
  const [kind, setKind] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const amountCents = parseRefundDollars(amount);
  const choice = refundChoice(kind);
  const tooMuch = amountCents !== null && amountCents > refundableCents;
  const ready = amountCents !== null && !tooMuch && choice !== null && confirmed && !working;
  const fieldId = (name: string) => `refund-${paymentIntentId}-${name}`;
  // After an unanswered attempt the same request id is kept, so the details
  // must not change: Stripe refuses a reused id with different details.
  const frozen = working || result?.retrySafe === true;

  async function submit() {
    if (locked.current || !ready || amountCents === null || !choice) return;
    locked.current = true;
    setWorking(true);
    try {
      const response = await fetchWithTimeout("/api/billing/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paymentIntentId,
          amountCents,
          kind: choice.kind,
          reason: reason.trim() || null,
          requestId: requestId.current,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) {
        const pending = body["status"] !== "succeeded";
        setResult({
          ok: true,
          message: pending
            ? `Refund of ${formatCents(amountCents)} sent. Stripe is still processing it; the bill updates when it completes.`
            : `Refunded ${formatCents(amountCents)} to ${customerName}'s card.`,
        });
        requestId.current = crypto.randomUUID();
        router.refresh();
        return;
      }
      const message = typeof body["error"] === "string" ? body["error"] : "The refund could not be confirmed. Refresh before trying again.";
      const retrySafe = body["retrySafe"] === true;
      // Stripe made the refund even though saving failed: never invite a second one.
      if (body["refunded"] === true) {
        setResult({ ok: true, message });
        requestId.current = crypto.randomUUID();
        router.refresh();
        return;
      }
      if (!retrySafe) requestId.current = crypto.randomUUID();
      setResult({ ok: false, message, retrySafe });
    } catch {
      // No answer at all: Stripe may have refunded. Keep the same request id
      // so trying again from this form cannot refund twice.
      setResult({
        ok: false,
        retrySafe: true,
        message: "The refund could not be confirmed. Try again from this same form, or check the payment in Stripe first.",
      });
    } finally {
      locked.current = false;
      setWorking(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="secondary-action" onClick={() => setOpen(true)}>
        Refund…
      </button>
    );
  }

  if (result?.ok) {
    return <p role="status" className="text-sm font-semibold text-good">{result.message}</p>;
  }

  return (
    <div className="mt-3 w-full max-w-xl space-y-3 rounded-xl border border-line bg-surface-2 p-4 text-sm">
      <div>
        <label className="font-semibold text-ink" htmlFor={fieldId("amount")}>Amount to refund</label>
        <input
          id={fieldId("amount")}
          inputMode="decimal"
          className="nums mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3"
          value={amount}
          disabled={frozen}
          aria-invalid={amountCents === null || tooMuch}
          onChange={(e) => { setAmount(e.target.value); setConfirmed(false); }}
        />
        <p className="mt-1 text-ink-2">
          {tooMuch
            ? `At most ${formatCents(refundableCents)} can still be refunded.`
            : amountCents === null
              ? "Enter an amount in dollars, like 25 or 25.50."
              : `Up to ${formatCents(refundableCents)} can be refunded.`}
        </p>
      </div>

      <div>
        <label className="font-semibold text-ink" htmlFor={fieldId("kind")}>Why is this being refunded?</label>
        <select
          id={fieldId("kind")}
          className="mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3"
          value={kind}
          disabled={frozen}
          onChange={(e) => { setKind(e.target.value); setConfirmed(false); }}
        >
          <option value="">Choose a reason</option>
          {REFUND_CHOICES.map((c) => (
            <option key={c.kind} value={c.kind}>{c.label}</option>
          ))}
        </select>
        {choice ? <p className="mt-1 text-ink-2">{choice.effect}</p> : null}
      </div>

      <div>
        <label className="font-semibold text-ink" htmlFor={fieldId("note")}>Note for the record (optional)</label>
        <input
          id={fieldId("note")}
          className="mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3"
          value={reason}
          maxLength={500}
          disabled={frozen}
          placeholder="For example: missed the guest bathroom"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      <label className="flex min-h-11 items-start gap-3 py-1">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0"
          checked={confirmed}
          disabled={frozen || amountCents === null || tooMuch || !choice}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>
          {amountCents !== null && !tooMuch && choice
            ? `Send ${formatCents(amountCents)} back to ${customerName}'s card. This cannot be undone.`
            : tooMuch
              ? "Lower the amount first."
              : "Choose an amount and a reason first."}
        </span>
      </label>

      {result && !result.ok ? (
        <p role="alert" className="font-semibold text-bad">
          {result.message}
          {result.retrySafe ? " The details are locked so a retry cannot refund twice." : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-full bg-navy px-5 py-2.5 font-semibold text-white disabled:opacity-50"
          disabled={!ready}
          onClick={() => void submit()}
        >
          {working ? "Refunding…" : result?.retrySafe ? "Try the refund again" : amountCents !== null && !tooMuch ? `Refund ${formatCents(amountCents)}` : "Refund"}
        </button>
        <button type="button" className="secondary-action" disabled={working} onClick={() => { setOpen(false); if (!result?.retrySafe) setResult(null); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
