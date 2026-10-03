"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { BUSINESS_TIME_ZONE } from "@/lib/time/zone";
import { FREQUENCY_LABELS, SERVICE_LABELS } from "@/lib/pricing/price-book";
import {
  QUOTE_LABELS,
  quoteCadence,
  toClientQuote,
  type ClientQuote,
  type QuoteAction,
} from "@/lib/quotes/types";
const quoteTime = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
export function QuoteSheet({ quote: q }: { quote: ClientQuote }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-navy">
            {SERVICE_LABELS[q.service]}
          </h2>
          <p className="mt-1 text-sm">
            {q.home.street}
            <br />
            {q.home.city}, {q.home.state} {q.home.zip}
          </p>
        </div>
        <span className="rounded-md bg-surface-2 px-3 py-2 text-sm">
          {QUOTE_LABELS[q.state]}
        </span>
      </div>
      <p className="nums mt-5 text-3xl font-semibold text-navy">
        {formatCents(q.totalCents)}
        <span className="ml-2 text-base font-normal text-ink-2">
          {q.repeats ? "per clean" : "for this clean"}
        </span>
      </p>
      <p className="mt-1 text-sm text-ink-2">
        {FREQUENCY_LABELS[q.frequency]} rate. {quoteCadence(q)}
      </p>
      <ul
        aria-label="Price breakdown"
        className="mt-5 divide-y divide-line-soft border-y border-line"
      >
        {q.lines.map((l) => (
          <li
            key={`${l.isExtra}-${l.itemKey}`}
            className="flex justify-between gap-4 py-3 text-sm"
          >
            <span className="min-w-0 break-words">
              {l.name} × {l.quantity}
            </span>
            <span className="nums shrink-0">{formatCents(l.totalCents)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-5 space-y-3 text-sm">
        <div>
          <dt className="font-semibold text-navy">
            {q.state === "booked"
              ? "Originally booked appointment"
              : "Proposed first appointment"}
          </dt>
          <dd className="mt-1">{quoteTime(q.proposedStart)} · Dallas time</dd>
        </div>
        <div>
          <dt className="font-semibold text-navy">Quote expires</dt>
          <dd className="mt-1">{quoteTime(q.expiresAt)} · Dallas time</dd>
        </div>
      </dl>
      {q.note && (
        <p className="mt-4 whitespace-pre-wrap break-words text-sm">{q.note}</p>
      )}
      <p className="mt-4 text-sm text-ink-2">
        {q.state === "booked"
          ? "Open the visit for its current time, cleaner and status."
          : "Accepting this quote lets the office book the proposed appointment. The cleaner is confirmed separately."}{" "}
        No payment is taken here. On appointment day, cancelling or moving to
        another date costs $60. Door turnaways also cost $60. Changing only the
        time that same day is free, as are earlier-day changes.
      </p>
    </>
  );
}
export function QuoteCard({
  quote,
  role,
  demo = false,
}: {
  quote: ClientQuote;
  role: "admin" | "customer";
  demo?: boolean;
}) {
  const [q, setQ] = useState(quote),
    [pending, setPending] = useState<Record<string, unknown> | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [needsRefresh, setNeedsRefresh] = useState(false);
  const router = useRouter();
  async function save(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setPending(body);
    setMessage("");
    try {
      const r = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await r.json();
      if (!r.ok) {
        const e = data as { error?: string };
        setMessage(
          typeof e?.error === "string"
            ? e.error
            : "Could not confirm the save. Retry the same action.",
        );
        if ([400, 401, 403, 409].includes(r.status)) {
          setNeedsRefresh(true);
          setPending(null);
        }
        return;
      }
      const next = toClientQuote(data);
      if (next.id !== q.id) throw new Error("Wrong quote");
      setQ(next);
      setPending(null);
      setMessage(
        next.state === "booked"
          ? "Appointment booked. Open the visit below."
          : next.state === "accepted"
            ? "Acceptance saved. The office will book the proposed appointment."
            : next.state === "declined"
              ? "Decision saved. The quote is declined."
              : next.state === "published"
                ? "Quote published in the client account."
                : next.state === "withdrawn"
                  ? "Quote withdrawn."
                  : "Quote updated.",
      );
      router.refresh();
    } catch {
      setMessage(
        "We could not confirm the save. Retry the same action to check its result.",
      );
    } finally {
      setBusy(false);
    }
  }
  function act(action: QuoteAction["action"], accept?: boolean) {
    const body: Record<string, unknown> = { action, id: q.id };
    if (action === "book") body.version = q.version;
    if (action === "decide") {
      body.version = q.version;
      body.accept = accept;
      body.requestId = crypto.randomUUID();
    }
    void save(body);
  }
  const editable = !demo && !needsRefresh && !pending && !busy;
  return (
    <article
      id={`quote-${q.id}`}
      className="visit-feature mt-5 max-w-2xl"
      aria-label={`Quote for ${q.home.street}`}
    >
      <QuoteSheet quote={q} />
      {message && (
        <p
          role="status"
          className="mt-5 whitespace-pre-wrap text-sm font-medium"
        >
          {message}
        </p>
      )}
      {q.state === "booked" ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {q.jobId ? (
            <Link
              className="primary-action"
              href={`/${role === "admin" ? "admin" : "customer"}/visits/${q.jobId}`}
            >
              Open booked visit
            </Link>
          ) : (
            <p className="text-sm">
              The original visit is no longer available. Call the office for its
              history.
            </p>
          )}
          {q.planId && (
            <Link
              className="secondary-action"
              href={
                role === "admin"
                  ? `/admin/customers/${q.customerId}/schedules`
                  : "/customer/schedules"
              }
            >
              Manage recurring schedule
            </Link>
          )}
        </div>
      ) : (
        <div className="mt-5 flex flex-wrap gap-3">
          {role === "admin" && q.state === "review" && (
            <button
              className="primary-action"
              disabled={!editable}
              onClick={() => act("publish")}
            >
              Publish in client account
            </button>
          )}
          {role === "admin" && q.state === "accepted" && (
            <button
              className="primary-action"
              disabled={!editable}
              onClick={() => act("book")}
            >
              Book proposed appointment
            </button>
          )}
          {role === "admin" && q.state !== "withdrawn" && (
            <button
              className="secondary-action"
              disabled={!editable}
              onClick={() => act("withdraw")}
            >
              Withdraw quote
            </button>
          )}
          {role === "customer" &&
            ["published", "accepted", "declined"].includes(q.state) && (
              <>
                {q.accepted !== true && (
                  <button
                    className="primary-action"
                    disabled={!editable}
                    onClick={() => act("decide", true)}
                  >
                    Accept quote
                  </button>
                )}
                {q.accepted !== false && (
                  <button
                    className="secondary-action"
                    disabled={!editable}
                    onClick={() => act("decide", false)}
                  >
                    {q.accepted ? "Withdraw acceptance" : "Decline quote"}
                  </button>
                )}
              </>
            )}
        </div>
      )}
      {busy && (
        <p role="status" className="mt-3 text-sm">
          Saving…
        </p>
      )}
      {pending && !busy && (
        <button
          className="primary-action mt-4"
          onClick={() => void save(pending)}
        >
          Retry the same action
        </button>
      )}
      {needsRefresh && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className="secondary-action"
            onClick={() => {
              setNeedsRefresh(false);
              router.refresh();
            }}
          >
            Refresh quote
          </button>
          <Link
            className="secondary-action"
            href={`/login?next=${encodeURIComponent(role === "admin" ? `/admin/customers/${q.customerId}/quotes` : "/customer/quotes")}`}
          >
            Sign in again
          </Link>
        </div>
      )}
      {demo && (
        <p className="mt-4 text-sm">
          Sample quote. Sign in to manage a real quote.
        </p>
      )}
      {["expired", "stale", "withdrawn"].includes(q.state) && (
        <p className="mt-4 text-sm">
          Ask the office for a new quote:{" "}
          <a className="underline" href="tel:+14692800397">
            469-280-0397
          </a>
          .
        </p>
      )}
    </article>
  );
}
