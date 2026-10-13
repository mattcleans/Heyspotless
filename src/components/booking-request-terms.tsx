import type { BookingReview } from "@/lib/booking/types";
import { SERVICE_LABELS, FREQUENCY_LABELS } from "@/lib/pricing/price-book";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { quoteCadence } from "@/lib/quotes/types";

// Original saved terms remain separate from the visit's current state.
export function BookingRequestTerms({ review }: { review: BookingReview }) {
  return <div className="mt-4 text-sm">
    <p className="font-semibold text-navy">Original Client request</p>
    <p className="mt-2">{review.home.street}, {review.home.city}, {review.home.state} {review.home.zip}</p>
    <p className="mt-2">{SERVICE_LABELS[review.service]} · {FREQUENCY_LABELS[review.frequency]} rate</p>
    <p className="mt-2 font-semibold nums">{formatCents(review.totalCents)} {review.repeats ? "per clean" : "for this clean"}</p>
    <dl className="mt-3 space-y-3">
      <div><dt className="font-semibold">Originally requested first appointment</dt>
        <dd>{formatDateTimeInZone(new Date(review.requestedStart))} · Dallas time</dd></div>
      <div><dt className="font-semibold">Originally requested repeating choice</dt>
        <dd>{quoteCadence({ proposedStart: review.requestedStart, frequency: review.frequency, repeats: review.repeats })}</dd></div>
      {review.note && <div><dt className="font-semibold">Original Client notes</dt>
        <dd className="whitespace-pre-wrap break-words">{review.note}</dd></div>}
    </dl>
    <ul className="mt-4 divide-y divide-line" aria-label="Original request price breakdown">
      {review.lines.map(line => <li key={line.itemKey} className="flex flex-wrap justify-between gap-2 py-2">
        <span className="min-w-0 break-words">{line.name} × {line.quantity}</span>
        <span className="nums">{formatCents(line.totalCents)}</span>
      </li>)}
    </ul>
  </div>;
}
