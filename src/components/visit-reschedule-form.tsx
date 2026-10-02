"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone, toLocalInputValue } from "@/lib/time/zone";
import {
  checkedReschedule,
  parseRescheduleTime,
  type RescheduleQuote,
  type RescheduleReceipt,
} from "@/lib/customer/reschedule/types";
const time = (v: string | null) =>
  v ? formatDateTimeInZone(new Date(v)) : "Time was not set";
export function RescheduleReceiptDetails({
  receipt,
}: {
  receipt: RescheduleReceipt;
}) {
  return (
    <section className="visit-feature mt-5" role="status">
      <p className="eyebrow">Appointment saved</p>
      <h2 className="mt-2 text-xl font-semibold text-navy">
        Your visit has moved
      </h2>
      <p className="mt-3 font-semibold text-navy">{time(receipt.newStart)}</p>
      <p className="mt-1 text-xs text-ink-2">Dallas time</p>
      <p className="mt-4 text-sm">
        No rescheduling fee. Visit price: {formatCents(receipt.priceCents)}.
      </p>
      <p className="mt-2 text-sm text-ink-2">
        The new time was saved for cleaner matching. Check the updated visit for
        your current assignment. Any assigned backup needs your approval before
        work starts.
      </p>
      <p className="mt-2 text-sm text-ink-2">
        Only this visit moved. Your recurring schedule stays the same.
      </p>
    </section>
  );
}
export function VisitRescheduleForm({
  jobId,
  currentStart,
  recurring,
  closed = false,
  office = false,
  preview = false,
  initialStart = "",
}: {
  jobId: string;
  currentStart: string | null;
  recurring: boolean;
  closed?: boolean;
  office?: boolean;
  preview?: boolean;
  initialStart?: string;
}) {
  const router = useRouter(),
    base = office ? "admin" : "customer",
    back = `/${base}/visits/${jobId}`;
  const [localStart, setLocalStart] = useState(
    initialStart ||
      (currentStart ? toLocalInputValue(new Date(currentStart)) : ""),
  );
  const [quote, setQuote] = useState<RescheduleQuote | null>(null),
    [receipt, setReceipt] = useState<RescheduleReceipt | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false),
    [signIn, setSignIn] = useState(false);
  async function submit(
    action: "review" | "confirm",
    selectedStart = localStart,
  ) {
    if (
      busy ||
      preview ||
      closed ||
      (action === "confirm" && (!quote || stale))
    )
      return;
    setBusy(true);
    setError("");
    setSignIn(false);
    try {
      const requested =
        action === "review"
          ? parseRescheduleTime(selectedStart).date.toISOString()
          : quote!.newStart;
      const r = await fetch(`/api/${base}/visits/${jobId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "review"
            ? { action, localStart: selectedStart }
            : { action, quoteId: quote!.id },
        ),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSignIn(r.status === 401);
        if (r.status === 409) {
          setStale(true);
          router.refresh();
        }
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "We could not confirm the new appointment. Try again or call the office.",
        );
      }
      if (action === "review") {
        const reviewed = checkedReschedule(data.quote, false);
        if (
          reviewed.jobId !== jobId ||
          Date.parse(reviewed.newStart) !== Date.parse(requested)
        )
          throw new Error(
            "The new appointment could not be confirmed. Review again.",
          );
        setQuote(reviewed);
        setStale(false);
      } else {
        const saved = checkedReschedule(data.receipt, true);
        if (
          data.rescheduled !== true ||
          saved.id !== quote!.id ||
          saved.jobId !== jobId ||
          Date.parse(saved.newStart) !== Date.parse(quote!.newStart) ||
          saved.priceCents !== quote!.priceCents ||
          Date.parse(saved.newEnd) !== Date.parse(quote!.newEnd) ||
          saved.releasedCount !== quote!.releasedCount
        )
          throw new Error(
            "We could not confirm the saved appointment. Retry to check the result, or call the office.",
          );
        setReceipt(saved);
        router.refresh();
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "We could not confirm the new appointment. Try again or call the office.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (receipt)
    return (
      <>
        <RescheduleReceiptDetails receipt={receipt} />
        <Link href={back} className="primary-action mt-4 w-full">
          View updated visit
        </Link>
      </>
    );
  if (closed)
    return (
      <p className="visit-feature mt-5">
        This visit has already started or closed. Call the office if you need
        help.
      </p>
    );
  return (
    <section className="card mt-5 p-5">
      <h2 className="text-xl font-semibold text-navy">
        {quote ? "Review your new appointment" : "Choose a new time"}
      </h2>
      {preview && (
        <p className="preview-note mt-3">
          Preview only. Sign in to reschedule a real appointment.
        </p>
      )}
      {quote ? (
        <>
          <dl className="mt-5 space-y-4 text-sm">
            <div>
              <dt className="eyebrow">Current appointment</dt>
              <dd className="mt-1">{time(quote.previousStart)}</dd>
            </div>
            <div className="rounded-xl bg-surface-2 p-4">
              <dt className="eyebrow">New appointment · Dallas time</dt>
              <dd className="mt-2 text-lg font-semibold text-navy">
                {time(quote.newStart)}
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Cost of this change</dt>
              <dd className="mt-1 font-semibold">
                $0.00 · Rescheduling is free
              </dd>
              <dd className="mt-1">
                Visit price stays {formatCents(quote.priceCents)}.
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink-2">
            {quote.releasedCount
              ? "The current cleaner assignment will be released."
              : "Cleaner matching will use the new time."}{" "}
            Your cleaner must be matched for the new appointment. Any assigned
            backup needs your approval before work starts.
          </p>
          <p className="mt-3 text-xs text-ink-2">
            This review expires after five minutes. Confirming saves the new
            time immediately.
          </p>
          <button
            type="button"
            onClick={() => submit("confirm")}
            disabled={busy || preview || stale}
            className="primary-action mt-5 w-full"
          >
            {busy ? "Saving…" : "Confirm new appointment · Free"}
          </button>
          <button
            type="button"
            onClick={() => {
              setQuote(null);
              setStale(false);
              setError("");
            }}
            disabled={busy}
            className="mt-2 min-h-11 w-full text-sm underline"
          >
            {stale ? "Review the current visit again" : "Choose another time"}
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const selected = new FormData(e.currentTarget).get("localStart");
            if (typeof selected === "string") {
              setLocalStart(selected);
              submit("review", selected);
            }
          }}
        >
          <p className="mt-3 text-sm text-ink-2">
            Rescheduling is free, including on appointment day.
          </p>
          <label
            htmlFor="reschedule-start"
            className="mt-5 block text-sm font-semibold"
          >
            New date and time · Dallas time
          </label>
          <input
            id="reschedule-start"
            name="localStart"
            type="datetime-local"
            step="60"
            required
            value={localStart}
            onChange={(e) => setLocalStart(e.target.value)}
            disabled={busy || preview}
            className="mt-2 block min-h-12 w-full min-w-0 rounded-lg border border-line px-3 py-3 text-sm"
          />
          <p className="mt-3 text-sm text-ink-2">
            Choose a future time within the next year. You will review the date,
            price and cleaner change before saving.
          </p>
          <button
            type="submit"
            disabled={busy || preview}
            className="primary-action mt-5 w-full"
          >
            {busy ? "Checking…" : "Review new appointment"}
          </button>
        </form>
      )}
      {recurring && (
        <p className="mt-4 text-sm text-ink-2">
          This changes only this visit. The rest of your recurring schedule
          stays the same.
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {signIn && (
        <Link
          href={`/login?next=${encodeURIComponent(`${back}/reschedule?start=${encodeURIComponent(localStart)}`)}`}
          className="secondary-action mt-3 inline-flex"
        >
          Sign in and keep this date
        </Link>
      )}
    </section>
  );
}
