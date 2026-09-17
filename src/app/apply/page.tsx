import { CUSTOMER_BRAND } from "@/lib/brand";
import { CLEANER_SHARE_OF_TICKET } from "@/lib/pricing/payout";
import { formatPct } from "@/lib/money";
import { ApplyForm } from "./apply-form";

/**
 * The public application page.
 *
 * WHAT IT SAYS BEFORE IT ASKS ANYTHING. The pay, as a share of the ticket, and
 * the fact that jobs are offered rather than assigned. Both are unusual enough
 * in this industry to be the reason somebody applies, and burying them under a
 * form is how you collect applications from people who leave in a month.
 *
 * It is also the honest version of the worker-classification position in
 * `docs/setup.md` item 9: a contractor who freely accepts or declines
 * company-priced jobs. If the page cannot say that plainly, the arrangement is
 * not what the schema says it is.
 */
export const metadata = {
  title: `Clean with ${CUSTOMER_BRAND}`,
  description: "Paid per clean, jobs offered rather than assigned, Dallas–Fort Worth.",
};

export default function ApplyPage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <p className="eyebrow">{CUSTOMER_BRAND}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy">Clean with us</h1>

      <div className="card mt-4 p-5">
        <p className="text-sm text-ink-2">
          You are paid <strong className="text-navy">{formatPct(CLEANER_SHARE_OF_TICKET, 0)} of
          what the customer pays</strong>, per clean — not an hourly rate, and not a rate that
          depends on our guess at how long a house takes.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          Work is <strong className="text-navy">offered, never assigned</strong>. Every job comes
          to your phone with the address, the time and the pay on it, and you accept it or you
          do not. Turning one down costs you nothing you were owed.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          Customers who like you keep you: a house you have cleaned comes back to you first,
          before anybody else sees it.
        </p>
      </div>

      <ApplyForm />
    </div>
  );
}
