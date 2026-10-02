"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  formatCalendarDate,
  formatDateTimeInZone,
  zonedTimeToUtc,
  type CalendarDate,
} from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
import {
  FREQUENCY_LABELS,
  frequenciesForService,
  type ServiceType,
} from "@/lib/pricing/price-book";
import {
  parseScheduleDraft,
  toScheduleQuote,
  toScheduleReceipt,
  receiptMatchesQuote,
  type ScheduleDraft,
  type ScheduleQuote,
  type ScheduleReceipt,
  type ScheduleReview,
} from "@/lib/customer/recurring/types";
const day = (date: string) => formatCalendarDate(date as CalendarDate);
const appointment = (date: string | null) =>
  date ? formatDateTimeInZone(new Date(date)) : "Time to be confirmed";
export function RecurringReview({ review }: { review: ScheduleReview }) {
  const visits = [...review.visits].sort(
    (a, b) =>
      Date.parse(a.new_start ?? a.previous_start ?? "") -
      Date.parse(b.new_start ?? b.previous_start ?? ""),
  );
  const boundary = zonedTimeToUtc(`${review.effective_from}T00:00`);
  const next = visits.find(
    (v) =>
      v.action !== "removed" &&
      v.new_start &&
      Date.parse(v.new_start) >=
        (boundary.ok ? boundary.date.getTime() : Infinity),
  );
  return (
    <section aria-label="Dates and price to review" className="mt-5 space-y-5">
      <div className="rounded-xl bg-navy p-5 text-white">
        <p className="text-xs font-semibold uppercase tracking-wider">
          Your new pattern
        </p>
        <p className="mt-2 text-xl font-semibold">
          {review.freq === "biweekly"
            ? "Every two weeks"
            : FREQUENCY_LABELS[review.freq]}{" "}
          · {review.start_time}
        </p>
        <p className="mt-2">{formatCents(review.price_cents)} per clean</p>
        {review.previous_price_cents !== review.price_cents && (
          <p className="mt-1 text-sm">
            Previously {formatCents(review.previous_price_cents)}. Existing
            billed visits and individual terms below keep their price.
          </p>
        )}
        <p className="mt-3 text-sm">
          {next
            ? `First future visit in this review: ${appointment(next.new_start)}`
            : "No future visits in this review. Check the pause and end dates."}
        </p>
      </div>
      <div className="text-sm text-ink-2">
        <p>
          Future edits take effect {day(review.effective_from)}. The pattern
          starts {day(review.first_date)}. Review covers dates through{" "}
          {day(review.horizon_until)}; this pattern continues after that
          {review.ends_on ? ` until ${day(review.ends_on)}` : ""}.
        </p>
        {review.paused_until && (
          <p className="mt-2">
            No pattern visits on or before {day(review.paused_until)}.
            Individually kept visits below stay booked.
          </p>
        )}
        <p className="mt-2">
          Schedule change fee: <strong className="text-navy">$0</strong>.
          Today’s appointment stays booked. Canceling it or moving it to another
          day costs $60; changing to another time today is free. Open that visit
          to review its fee.
        </p>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-navy">
          Every visit affected
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Kept visits retain their time, price and current assignment. Moved
          visits need a new cleaner acceptance; you approve any proposed backup
          before work starts.
        </p>
        <ol className="mt-4 divide-y divide-line border-y border-line">
          {visits.map((v, i) => (
            <li
              key={v.job_id ?? `new-${v.new_occurrence}-${i}`}
              className="py-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-full border border-line px-2.5 py-1 text-xs font-semibold text-navy">
                  {
                    {
                      added: "Added",
                      moved: "Moved",
                      removed: "Removed",
                      kept: "Kept",
                    }[v.action]
                  }
                </span>
                <span className="text-sm font-semibold">
                  {v.new_price_cents === null
                    ? "No visit charge"
                    : formatCents(v.new_price_cents)}
                </span>
              </div>
              <p className="mt-2 font-medium">
                {appointment(v.new_start ?? v.previous_start)}
              </p>
              {v.action === "moved" && (
                <p className="mt-1 text-sm text-ink-2">
                  Previously {appointment(v.previous_start)}
                  {v.previous_price_cents !== v.new_price_cents
                    ? ` · ${formatCents(v.previous_price_cents ?? 0)}`
                    : ""}
                </p>
              )}
              <p className="mt-1 text-sm text-ink-2">
                {v.reason}
                {v.action === "removed"
                  ? ". This visit is canceled without a fee."
                  : ""}
              </p>
              {v.action === "kept" && v.fills_date && (
                <p className="mt-1 text-xs text-ink-2">
                  Fills the {day(v.fills_date)} occurrence; no additional clean
                  for that slot.
                </p>
              )}
              {v.action === "kept" && !v.fills_date && (
                <p className="mt-1 text-xs text-ink-2">
                  Kept separately. If the future pattern falls on this same day,
                  this visit fills that occurrence. Open the visit to change it
                  separately.
                </p>
              )}
              {v.released_count > 0 && (
                <p className="mt-1 text-xs text-ink-2">
                  {v.released_count} current contractor assignment
                  {v.released_count === 1 ? "" : "s"} will be released.
                </p>
              )}
            </li>
          ))}
        </ol>
        {visits.length === 0 && (
          <p className="mt-3 text-sm">
            No visits are created in this review window.
          </p>
        )}
      </div>
      {review.preserved_skips.length > 0 && (
        <p className="text-sm text-ink-2">
          Previously skipped dates stay skipped:{" "}
          {review.preserved_skips.map(day).join(", ")}.
        </p>
      )}
    </section>
  );
}
export function RecurringScheduleForm({
  planId,
  initialDraft,
  minDate,
  maxDate,
  office = false,
  service = "standard",
}: {
  planId: string;
  initialDraft: ScheduleDraft;
  minDate: string;
  maxDate: string;
  office?: boolean;
  service?: ServiceType;
}) {
  const router = useRouter(),
    [draft, setDraft] = useState(initialDraft),
    [quote, setQuote] = useState<ScheduleQuote | null>(null),
    [receipt, setReceipt] = useState<ScheduleReceipt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [signIn, setSignIn] = useState(false),
    [retry, setRetry] = useState(false);
  const availableFrequencies = (
    ["weekly", "biweekly", "monthly"] as const
  ).filter(
    (f) =>
      frequenciesForService(service).includes(f) ||
      f === initialDraft.frequency,
  );
  const base = office ? "admin" : "customer",
    endpoint = `/api/${base}/schedules/${planId}`;
  function edit(key: keyof ScheduleDraft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setQuote(null);
    setError("");
    setRetry(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>, confirm: boolean) {
    event.preventDefault();
    if (busy) return;
    let body;
    try {
      body =
        confirm && quote
          ? { action: "confirm", quoteId: quote.id }
          : {
              action: "review",
              draft: parseScheduleDraft(
                Object.fromEntries(new FormData(event.currentTarget)),
              ),
            };
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check your schedule.");
      return;
    }
    if (body.action === "review") setDraft(body.draft!);
    setBusy(true);
    setError("");
    setSignIn(false);
    try {
      const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        data = await response.json();
      if (!response.ok) {
        if (response.status === 401) setSignIn(true);
        if (response.status === 409) setQuote(null);
        setRetry(confirm && response.status >= 500);
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "We could not verify your schedule.",
        );
      }
      if (confirm && quote) {
        const saved = toScheduleReceipt(data.receipt);
        if (data.saved !== true || !receiptMatchesQuote(saved, quote))
          throw new Error(
            "The saved dates could not be verified. Retry to check the result, or call the office.",
          );
        setReceipt(saved);
        setRetry(false);
        router.refresh();
      } else {
        const reviewed = toScheduleQuote(data.quote);
        if (reviewed.review.plan_id !== planId)
          throw new Error("Open this schedule again to review it.");
        setQuote(reviewed);
        setRetry(false);
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Connection lost. Retry to check your saved schedule.",
      );
      if (confirm) setRetry(true);
    } finally {
      setBusy(false);
    }
  }
  if (receipt)
    return (
      <section className="visit-feature mt-5" aria-live="polite">
        <p className="text-xs font-semibold uppercase tracking-wider text-navy">
          Schedule saved
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-navy">
          Your future visits are updated
        </h2>
        <p className="mt-2 text-sm">
          Saved {appointment(receipt.confirmed_at)}. No schedule change fee or
          payment was charged.
        </p>
        <RecurringReview review={receipt.review} />
        <Link
          className="primary-action mt-5 inline-flex"
          href={office ? `/admin/schedules/${planId}` : "/customer/visits"}
        >
          {office ? "View current schedule" : "View your visits"}
        </Link>
      </section>
    );
  return (
    <form
      className="visit-feature mt-5"
      onSubmit={(e) => submit(e, Boolean(quote))}
      aria-busy={busy}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-navy">
        {quote
          ? "2. Review every change before saving"
          : "1. Choose your pattern · 2. Review every change"}
      </p>
      {!quote && (
        <>
          <fieldset
            disabled={busy || Boolean(quote)}
            className="mt-5 grid gap-4 sm:grid-cols-2"
          >
            <legend className="sr-only">New recurring schedule</legend>
            <label className="min-w-0 text-sm font-medium">
              Frequency
              <select
                name="frequency"
                className="mt-2 block min-h-12 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                value={draft.frequency}
                onChange={(e) => edit("frequency", e.target.value)}
              >
                {availableFrequencies.map((f) => (
                  <option key={f} value={f}>
                    {f === "biweekly" ? "Every two weeks" : FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-sm font-medium">
              First date in the new pattern
              <input
                required
                type="date"
                name="firstDate"
                className="mt-2 block min-h-12 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                min={minDate}
                max={maxDate}
                value={draft.firstDate}
                onChange={(e) => edit("firstDate", e.target.value)}
              />
            </label>
            <label className="min-w-0 text-sm font-medium">
              Arrival time · Dallas
              <input
                required
                type="time"
                name="startTime"
                className="mt-2 block min-h-12 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                step="60"
                value={draft.startTime}
                onChange={(e) => edit("startTime", e.target.value)}
              />
            </label>
            <div className="text-sm text-ink-2">
              Monthly means the same numbered weekday, such as the second
              Tuesday. A fifth weekday uses the last matching weekday in shorter
              months. Clock changes use the first valid time shown in the
              review.
            </div>
            <label className="min-w-0 text-sm font-medium">
              Pause through <span className="font-normal">(optional)</span>
              <input
                type="date"
                name="pausedUntil"
                className="mt-2 block min-h-12 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                value={draft.pausedUntil}
                onChange={(e) => edit("pausedUntil", e.target.value)}
              />
              <span className="mt-1 block text-xs font-normal text-ink-2">
                No new pattern visits on or before this date.
              </span>
            </label>
            <label className="min-w-0 text-sm font-medium">
              Last date <span className="font-normal">(optional)</span>
              <input
                type="date"
                name="endsOn"
                className="mt-2 block min-h-12 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                min={draft.firstDate}
                value={draft.endsOn}
                onChange={(e) => edit("endsOn", e.target.value)}
              />
              <span className="mt-1 block text-xs font-normal text-ink-2">
                Leave blank to keep the pattern ongoing.
              </span>
            </label>
          </fieldset>
          <p className="mt-4 text-sm text-ink-2">
            Day and time changes keep your agreed price. A frequency change
            reviews the current price for that frequency. Today’s visit and
            existing billed or individually changed appointments keep their
            current terms.
          </p>
        </>
      )}
      {quote && <RecurringReview review={quote.review} />}
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-line p-3 text-sm"
        >
          {error}
        </p>
      )}
      {signIn && (
        <Link
          className="secondary-action mt-4 inline-flex"
          href={`/login?next=${encodeURIComponent(`/${base}/schedules/${planId}?draft=${encodeURIComponent(JSON.stringify(draft))}`)}`}
        >
          Sign in and keep these choices
        </Link>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          disabled={busy || signIn}
          className="primary-action"
          type="submit"
        >
          {busy
            ? "Checking schedule…"
            : quote
              ? retry
                ? "Retry confirmation"
                : "Confirm future schedule"
              : "Review dates and price"}
        </button>
        {quote && (
          <button
            disabled={busy}
            className="secondary-action"
            type="button"
            onClick={() => {
              setQuote(null);
              setError("");
              setRetry(false);
            }}
          >
            Edit choices
          </button>
        )}
      </div>
      {quote && (
        <p className="mt-3 text-xs text-ink-2">
          Review expires after five minutes. Confirmation saves these dates
          immediately.
        </p>
      )}
    </form>
  );
}
