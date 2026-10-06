"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SERVICE_LABELS, SERVICE_TYPES, FREQUENCY_LABELS, PRICE_BOOK_EXTRAS as EXTRAS, frequenciesForService, type ServiceType, type Frequency } from "@/lib/pricing/price-book";
import { buildQuote, type RoomCounts } from "@/lib/pricing/quote";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone, toLocalInputValue } from "@/lib/time/zone";
import { quoteCadence } from "@/lib/quotes/types";
import { bookingReviewMatches, parseBookingAction, toBookingReview, type BookingAction, type BookingReview } from "@/lib/booking/types";
export type BookingHome = { id: string; street: string; city: string; state: string; zip: string; rooms: RoomCounts };
const field = "mt-2 min-h-11 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-2 text-base";
const time = (s: string) => `${formatDateTimeInZone(new Date(s))} · Dallas time`;
function Receipt({ review, headingRef }: { review: BookingReview; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  const saved = review.state === "requested", canceled = review.state === "canceled";
  return <section className="visit-feature mt-5">
    <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-navy">{saved ? "Request saved" : canceled ? "This visit was canceled" : "Saved visit unavailable"}</h2>
    <p className="mt-2 text-sm">{review.home.street}, {review.home.city}</p>
    <p className="mt-2 text-sm">Originally requested: {time(review.requestedStart)}</p>
    <p className="mt-2 text-sm">{SERVICE_LABELS[review.service]} · {formatCents(review.totalCents)} {review.repeats ? "per clean" : "for this clean"}.</p>
    <p className="mt-2 text-sm text-ink-2">{saved ? "Open your visit for the current appointment, matching and approval status. A request does not confirm a Cleaner. No payment was taken here."
      : canceled ? "This receipt retains your original request. Open the visit for its cancellation and fee details."
      : "Call the office to review this request’s history. Retrying it will not create another visit."}</p>
    {review.jobId && <Link href={`/customer/visits/${review.jobId}`} className="primary-action mt-4 inline-flex">Open visit</Link>}
    {review.planId && <Link href="/customer/schedules" className="secondary-action mt-3 inline-flex">Manage recurring schedule</Link>}
  </section>;
}
export function BookingForm({ homes, initialService = "standard", reviews, demo = false }: {
  homes: BookingHome[]; initialService?: ServiceType; reviews: BookingReview[]; demo?: boolean;
}) {
  const router = useRouter(), heading = useRef<HTMLHeadingElement>(null);
  const [propertyId, setHome] = useState(homes[0]?.id ?? ""), [service, setService] = useState<ServiceType>(initialService),
    [frequency, setFrequency] = useState<Frequency>("one_time"), [repeats, setRepeats] = useState(false),
    [start, setStart] = useState(""), [extras, setExtras] = useState<Record<string, number>>({}), [note, setNote] = useState(""),
    [review, setReview] = useState<BookingReview | null>(null), [pending, setPending] = useState<BookingAction | null>(null),
    [busy, setBusy] = useState(false), [error, setError] = useState(""), [signIn, setSignIn] = useState(false),
    [needsReview, setNeedsReview] = useState(false);
  const home = homes.find(h => h.id === propertyId);
  const choicesLocked = busy || !!pending || !!review || signIn;
  useEffect(() => { if (review) heading.current?.focus(); }, [review]);
  let estimate = null;
  try { if (home) estimate = buildQuote(service, frequency, home.rooms, Object.entries(extras).filter(([, q]) => q > 0).map(([itemKey, quantity]) => ({ itemKey, quantity }))); } catch { /* The exact server review is authoritative. */ }
  async function save(action: BookingAction) {
    if (busy || demo) return;
    setPending(action); setBusy(true); setError("");
    try {
      const res = await fetch("/api/customer/book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : "Could not confirm the save. Retry the same action.");
        if ([400, 403, 409].includes(res.status)) { setPending(null); if (action.action === "confirm") setNeedsReview(true); }
        if (res.status === 401) setSignIn(true);
        return;
      }
      const result = toBookingReview(data);
      if (!bookingReviewMatches(parseBookingAction(action), result)) throw new Error("Wrong review");
      setReview(result); setPending(null); setNeedsReview(false); router.refresh();
    } catch { setError("We could not confirm the save. Retry the same action to recover its result; your choices are still here."); }
    finally { setBusy(false); }
  }
  function edit() {
    if (review) {
      const owned = homes.some(h => h.id === review.propertyId);
      setHome(owned ? review.propertyId : homes[0]?.id ?? ""); setService(review.service);
      setFrequency(review.frequency); setRepeats(review.repeats);
      setStart(["requested", "canceled", "unavailable"].includes(review.state) || Date.parse(review.requestedStart) <= Date.now()
        ? "" : toLocalInputValue(new Date(review.requestedStart)));
      setExtras(Object.fromEntries(review.lines.filter(l => l.isExtra).map(l => [l.itemKey, l.quantity]))); setNote(review.note);
      setError(owned ? "" : "The original home is no longer connected. Choose your current saved home before reviewing again.");
    } else setError("");
    setReview(null); setNeedsReview(false);
  }
  if (!homes.length) return <><section className="visit-feature mt-5"><h2 className="font-semibold text-navy">Connect your home first</h2>
    <p className="mt-2 text-sm">If you already clean with us, call the office to connect your saved home. Use the new-home request below for another address.</p></section>
    {reviews.filter(r => ["requested", "canceled", "unavailable"].includes(r.state)).map(r => <Receipt key={r.id} review={r} />)}</>;
  return <div className="mt-6 max-w-2xl">
    {review && !["review", "expired", "stale"].includes(review.state) ? <Receipt review={review} headingRef={heading} />
      : review ? <section className="visit-feature" aria-labelledby="booking-review">
        <h2 id="booking-review" ref={heading} tabIndex={-1} className="text-xl font-semibold text-navy">{needsReview ? "Last loaded price review" : "Review your clean"}</h2>
        <p className="mt-3 text-sm">{review.home.street}<br />{review.home.city}, {review.home.state} {review.home.zip}</p>
        <p className="mt-4 text-sm">{SERVICE_LABELS[review.service]} · {FREQUENCY_LABELS[review.frequency]} rate</p>
        <p className="mt-2 text-3xl font-semibold nums text-navy">{formatCents(review.totalCents)}<span className="ml-2 text-base font-normal">{review.repeats ? "per clean" : "for this clean"}</span></p>
        <ul aria-label="Exact price breakdown" className="mt-4 divide-y divide-line">
          {review.lines.map(l => <li key={`${l.isExtra}-${l.itemKey}`} className="flex justify-between gap-4 py-3 text-sm"><span className="min-w-0 break-words">{l.name} × {l.quantity}</span><span className="nums shrink-0">{formatCents(l.totalCents)}</span></li>)}
        </ul>
        <dl className="mt-4 space-y-3 text-sm"><div><dt className="font-semibold">Requested first appointment</dt><dd>{time(review.requestedStart)}</dd></div>
          <div><dt className="font-semibold">Repeating choice</dt><dd>{quoteCadence({ proposedStart: review.requestedStart, frequency: review.frequency, repeats: review.repeats })}</dd></div>
          {review.note && <div><dt className="font-semibold">Your notes</dt><dd className="whitespace-pre-wrap break-words">{review.note}</dd></div>}
          <div><dt className="font-semibold">Review valid until</dt><dd>{time(review.expiresAt)}</dd></div></dl>
        <p className="mt-4 text-sm text-ink-2">We’ll match a Cleaner for your requested appointment. Check the visit for confirmation and approve any backup before work starts. No payment is taken here.</p>
        <p className="mt-3 text-sm text-ink-2">On appointment day, canceling or moving to another date costs $60. Door turnaways also cost $60. Changing only the time that same day is free, as are earlier-day changes.</p>
        {review.state !== "review" && <p role="status" className="mt-4 text-sm">{review.state === "expired" ? "This price review expired." : "Your saved home changed."} Review your choices again before requesting the clean.</p>}
        <button disabled={busy || !!pending || signIn || needsReview || demo || review.state !== "review"} className="primary-action mt-5 w-full" onClick={() => void save({ action: "confirm", id: review.id })}>{busy ? "Saving…" : review.repeats ? "Request recurring cleans" : "Request this clean"}</button>
        <button disabled={busy || !!pending || signIn} className="secondary-action mt-3 w-full" onClick={edit}>Edit and review again</button>
        {needsReview && <a href="" className="secondary-action mt-3 inline-flex">Refresh saved home details</a>}
      </section> : <form className="space-y-5" onSubmit={e => { e.preventDefault(); if (choicesLocked || demo || !home) return;
        void save({ action: "review", id: crypto.randomUUID(), propertyId, service, frequency, start, repeats,
          extras: Object.entries(extras).filter(([, q]) => q > 0).map(([itemKey, quantity]) => ({ itemKey, quantity })), note }); }}>
        <fieldset disabled={choicesLocked || demo} className="space-y-5">
          <label className="block text-sm font-medium">Your saved home<select className={field} value={propertyId} onChange={e => setHome(e.target.value)}>{homes.map(h => <option key={h.id} value={h.id}>{h.street}, {h.city}</option>)}</select></label>
          {home && <p className="text-sm text-ink-2">{home.rooms.bedrooms} bedrooms, {home.rooms.bathrooms} full baths, {home.rooms.halfBaths ?? 0} half baths, {home.rooms.kitchens ?? 1} kitchens, {home.rooms.livingRooms ?? 1} living rooms and {home.rooms.utilityRooms ?? 1} utility rooms. <Link href="/customer/account/homes" className="underline">Review home instructions</Link>.</p>}
          <label className="block text-sm font-medium">Service<select className={field} value={service} onChange={e => { setService(e.target.value as ServiceType); setFrequency("one_time"); setRepeats(false); }}>{SERVICE_TYPES.map(s => <option key={s} value={s}>{SERVICE_LABELS[s]}</option>)}</select></label>
          <label className="block text-sm font-medium">Visit rate<select className={field} value={frequency} onChange={e => { setFrequency(e.target.value as Frequency); if (e.target.value === "one_time") setRepeats(false); }}>{frequenciesForService(service).map(f => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}</select></label>
          <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={repeats} disabled={frequency === "one_time" || choicesLocked || demo} onChange={e => setRepeats(e.target.checked)} /><span>Repeat this clean<span className="mt-1 block text-ink-2">{repeats ? "Creates an additional recurring schedule starting with the appointment below. Review the pattern before confirming." : "One visit only. Choosing a rate does not enroll you in a recurring schedule."}</span></span></label>
          <label className="block text-sm font-medium">Preferred appointment · Dallas time<input type="datetime-local" required className={field} value={start} onChange={e => setStart(e.target.value)} /></label>
          <fieldset className="divide-y divide-line"><legend className="mb-2 text-sm font-semibold">Extras</legend>{EXTRAS.map(extra => <label key={extra.itemKey} className="flex items-center justify-between gap-3 py-3 text-sm"><span className="min-w-0">{extra.name}<span className="block text-ink-2">{formatCents(extra.priceCents)} {extra.unitLabel}</span></span><input aria-label={`${extra.name} quantity`} type="number" min={0} max={20} step={1} className="min-h-11 w-20 shrink-0 rounded-lg border border-line px-3 py-2 text-base" value={extras[extra.itemKey] ?? 0} onChange={e => setExtras(old => ({ ...old, [extra.itemKey]: Number(e.target.value) }))} /></label>)}</fieldset>
          <label className="block text-sm font-medium">Notes for this clean<textarea maxLength={1500} rows={3} className={field} value={note} onChange={e => setNote(e.target.value)} /></label>
        </fieldset>
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-line pt-4"><span className="text-sm">Estimated {repeats ? "price per clean" : "visit price"}</span><span className="text-2xl font-semibold nums text-navy">{estimate ? formatCents(estimate.totalCents) : "Review for price"}</span></div>
        <p className="text-sm text-ink-2">Review the exact price before requesting this appointment. Your existing contact details and home instructions stay connected.</p>
        <button disabled={choicesLocked || demo || !home} className="primary-action w-full" type="submit">{demo ? "Preview only · saving is off" : busy ? "Reviewing…" : "Review exact price"}</button>
      </form>}
    {error && <p role="alert" className="mt-4 whitespace-pre-wrap text-sm text-bad">{error}</p>}
    {signIn && <Link href="/login?next=%2Fcustomer%2Fbook" className="secondary-action mt-4 inline-flex">Sign in to continue</Link>}
    {pending && !signIn && <button disabled={busy} onClick={() => void save(pending)} className="primary-action mt-4 w-full">{busy ? "Checking…" : "Retry the same action"}</button>}
    {review && ["requested", "canceled", "unavailable"].includes(review.state) && <button disabled={busy || !!pending} className="secondary-action mt-4 w-full" onClick={edit}>Request another clean</button>}
    {reviews.some(r => r.id !== review?.id) && <section className="mt-7" aria-labelledby="recent-bookings"><h2 id="recent-bookings" className="text-xl font-semibold text-navy">Your recent requests and reviews</h2>
      <p className="mt-2 text-sm text-ink-2">Up to 20 saved records. Reopening a receipt does not create another visit.</p>
      <ul className="mt-3 divide-y divide-line">{reviews.filter(r => r.id !== review?.id).map(r => <li key={r.id} className="py-4 text-sm"><p className="font-semibold">{r.home.street}</p><p className="mt-1">{time(r.requestedStart)} · {formatCents(r.totalCents)} {r.repeats ? "per clean" : "for this clean"}</p>
        <button disabled={busy || !!pending || signIn} className="secondary-action mt-3 inline-flex" onClick={() => { setReview(r); setError(""); setNeedsReview(false); }}>{r.state === "review" ? "Continue price review" : ["expired", "stale"].includes(r.state) ? "Review saved choices" : "Open request receipt"}<span className="sr-only"> for {r.home.street}, {time(r.requestedStart)}</span></button></li>)}</ul>
    </section>}
  </div>;
}
