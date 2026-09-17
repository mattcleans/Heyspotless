import { CUSTOMER_BRAND } from "@/lib/brand";
import { BookingWidget } from "./booking-widget";

/**
 * The public booking page.
 *
 * Deliberately outside every gated area: no session, no nav, no role. The
 * Webflow marketing site links or iframes this, which is why there is no
 * Spotless Ops chrome on it anywhere — a homeowner booking a clean should never
 * learn the name of the software.
 */
export const metadata = {
  title: `Book a clean — ${CUSTOMER_BRAND}`,
  description: "Room counts to a real price, in four seconds.",
};

export default function BookPage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <p className="eyebrow">{CUSTOMER_BRAND}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy">Book a clean</h1>
      <p className="mt-2 mb-6 text-sm text-ink-2">
        A real price from your room counts — no waiting for a call back to find out what it
        costs. Dallas–Fort Worth.
      </p>

      <BookingWidget />
    </div>
  );
}
