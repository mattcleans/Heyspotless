"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";

/**
 * The two buttons that talk to Stripe.
 *
 * Both do the same thing: ask our own API for a hosted Stripe URL and follow
 * it. No card field is ever rendered by this app, which is what keeps card data
 * out of our DOM, our logs and our PCI scope entirely.
 */

type State = { status: "idle" | "working" } | { status: "error"; message: string };

async function startSession(path: string, body: unknown): Promise<string> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json().catch(() => ({}));
  const data = (payload ?? {}) as { url?: unknown; error?: unknown };

  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Something went wrong.");
  }
  if (typeof data.url !== "string") {
    throw new Error("Stripe did not return a payment page.");
  }
  return data.url;
}

export function PayInvoiceButton({
  invoiceId,
  balanceCents,
  hasCard,
}: {
  invoiceId: string;
  balanceCents: number;
  hasCard: boolean;
}) {
  const [state, setState] = useState<State>({ status: "idle" });

  async function pay() {
    setState({ status: "working" });
    try {
      // Offer to keep the card only when there isn't one — a customer who has
      // already saved one is not asked again on every payment.
      window.location.href = await startSession("/api/billing/checkout", {
        invoiceId,
        saveCard: !hasCard,
      });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={pay}
        disabled={state.status === "working"}
        className="rounded-lg bg-navy px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-deep disabled:opacity-50"
      >
        {state.status === "working" ? "Opening…" : `Pay ${formatCents(balanceCents)}`}
      </button>
      {state.status === "error" ? (
        <p className="mt-1.5 text-xs text-bad">{state.message}</p>
      ) : null}
    </div>
  );
}

export function SaveCardButton({
  hasCard,
  autopayEnabled,
}: {
  hasCard: boolean;
  autopayEnabled: boolean;
}) {
  const [autopay, setAutopay] = useState(autopayEnabled);
  const [state, setState] = useState<State>({ status: "idle" });

  async function save() {
    setState({ status: "working" });
    try {
      window.location.href = await startSession("/api/billing/save-card", { autopay });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }

  return (
    <div className="mt-4">
      {/*
        Two separate permissions, asked separately. A card on file is not
        consent to charge it, and the timestamp this writes is the evidence
        that the customer agreed — see the CHECK constraint in 0006.
      */}
      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-2">
        <input
          type="checkbox"
          checked={autopay}
          onChange={(e) => setAutopay(e.target.checked)}
          className="mt-0.5 size-4 accent-[var(--color-navy)]"
        />
        <span>
          Charge this card automatically when a clean is invoiced. You can turn this off at
          any time.
        </span>
      </label>

      <button
        type="button"
        onClick={save}
        disabled={state.status === "working"}
        className="mt-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-sm font-semibold text-navy transition-colors hover:bg-sunk disabled:opacity-50"
      >
        {state.status === "working" ? "Opening…" : hasCard ? "Replace card" : "Add a card"}
      </button>

      {state.status === "error" ? (
        <p className="mt-1.5 text-xs text-bad">{state.message}</p>
      ) : null}
    </div>
  );
}
