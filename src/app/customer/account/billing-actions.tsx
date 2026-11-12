"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";
import { PaymentSessionError, startSession, uncertainPayment } from "./payment-session";

/**
 * The two buttons that talk to Stripe.
 *
 * Both do the same thing: ask our own API for a hosted Stripe URL and follow
 * it. No card field is ever rendered by this app, which is what keeps card data
 * out of our DOM, our logs and our PCI scope entirely.
 */

type State = { status: "idle" | "working" } | { status: "error"; error: PaymentSessionError };

export function PaymentSessionNotice({ error }: { error: PaymentSessionError }) {
  const action = error.recovery === "office"
    ? { href: "tel:+14692800397", label: "Call the office" }
    : error.recovery === "sign_in"
      ? { href: "/login?next=%2Fcustomer%2Faccount", label: "Sign in" }
      : { href: "/customer/account", label: "Refresh Account" };
  return (
    <div role="alert" className="mt-2 max-w-sm text-sm text-ink-2">
      <p>{error.message}</p>
      {/* A full navigation re-reads the account instead of preserving its old balance. */}
      <a href={action.href} className="mt-1 inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-navy underline underline-offset-4">
        {action.label}
      </a>
    </div>
  );
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
        expectedBalanceCents: balanceCents,
        saveCard: !hasCard,
      });
    } catch (error) {
      setState({ status: "error", error: error instanceof PaymentSessionError ? error : uncertainPayment() });
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={pay}
        disabled={state.status !== "idle"}
        className="min-h-11 rounded-lg bg-navy px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-deep disabled:opacity-50"
      >
        {state.status === "working" ? "Opening…" : `Pay ${formatCents(balanceCents)}`}
      </button>
      {state.status === "error" ? (
        <PaymentSessionNotice error={state.error} />
      ) : null}
    </div>
  );
}

export function SaveCardButton({
  hasCard,
  autopayEnabled,
  allowAutopay = false,
}: {
  hasCard: boolean;
  autopayEnabled: boolean;
  allowAutopay?: boolean;
}) {
  const [autopay, setAutopay] = useState(allowAutopay && autopayEnabled);
  const [state, setState] = useState<State>({ status: "idle" });

  async function save() {
    setState({ status: "working" });
    try {
      window.location.href = await startSession("/api/billing/save-card", allowAutopay ? { autopay } : {});
    } catch (error) {
      setState({ status: "error", error: error instanceof PaymentSessionError ? error : uncertainPayment() });
    }
  }

  return (
    <div className="mt-4">
      {/*
        Two separate permissions, asked separately. A card on file is not
        consent to charge it, and the timestamp this writes is the evidence
        that the customer agreed — see the CHECK constraint in 0006.
      */}
      {allowAutopay ? <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-2">
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
      </label> : <p className="text-sm text-ink-2">Save a card for payments you choose to make. Automatic payments are paused.</p>}

      <button
        type="button"
        onClick={save}
        disabled={state.status !== "idle"}
        className="mt-3 min-h-11 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-sm font-semibold text-navy transition-colors hover:bg-sunk disabled:opacity-50"
      >
        {state.status === "working" ? "Opening…" : hasCard ? "Replace card" : "Add a card"}
      </button>

      {state.status === "error" ? (
        <PaymentSessionNotice error={state.error} />
      ) : null}
    </div>
  );
}
