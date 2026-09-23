import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { isBillingEnabled } from "@/lib/stripe/env";
import { isMessagingEnabled } from "@/lib/messaging/env";
import { formatDateTimeInZone } from "@/lib/time/zone";
import {
  automationState,
  type AutomationRecord,
} from "@/lib/operations/automation-status";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automation | Hey Spotless" };
export default async function AutomationPage() {
  const demo = isDemoMode();
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  let records: AutomationRecord[] = [];
  let decisions: {
    id: string;
    kind: string;
    decided_at: string;
    decided_by: string | null;
  }[] = [];
  let unavailable = false;
  if (!demo) {
    const db = await createClient();
    const [messages, matching] = await Promise.all([
      db
        .from("automations")
        .select("id, outcome, error, fired_at, scheduled_for")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500),
      db
        .from("dispatch_decisions")
        .select("id, kind, decided_at, decided_by")
        .gte("decided_at", since)
        .order("decided_at", { ascending: false })
        .limit(500),
    ]);
    unavailable = Boolean(messages.error || matching.error);
    if (!unavailable) {
      records = (messages.data ?? []) as AutomationRecord[];
      decisions = (matching.data ?? []) as typeof decisions;
    }
  }
  const states = records.map((row) => automationState(row, now));
  const stopped = states.filter((s) => s === "stopped").length;
  const overdue = states.filter((s) => s === "overdue").length;
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight text-navy">
        Let the platform do the follow-through.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">
        Matching, reminders, and follow-ups should run in the background. This
        view surfaces the work that may need a person.
      </p>
      {demo ? (
        <p className="preview-note mt-6 rounded-xl">
          Live activity is not available in preview. No automation has been run
          from this screen.
        </p>
      ) : unavailable ? (
        <p role="alert" className="visit-feature mt-6">
          Activity could not be loaded. Refresh this page before relying on the
          counts.
        </p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[
              [
                "Automatic matching decisions",
                decisions.filter((d) => !d.decided_by).length,
              ],
              ["Messages sent", states.filter((s) => s === "sent").length],
              ["Delivery problems", stopped],
              ["Overdue messages", overdue],
            ].map(([label, value]) => (
              <div key={label} className="card p-5">
                <p className="text-sm text-ink-2">{label}</p>
                <p className="mt-2 text-3xl font-semibold text-navy">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-2">
            Last seven days, up to 500 recent records in each category. Matching
            decisions are not completed bookings. Activity counts do not confirm
            that the scheduler is healthy.
          </p>
          {(stopped > 0 || overdue > 0) && (
            <section className="visit-feature mt-6">
              <h2 className="font-semibold text-navy">
                Follow-through needs attention
              </h2>
              <p className="mt-2 text-sm text-ink-2">
                {stopped} delivery problems and {overdue} overdue messages are
                recorded in this sample. Check the conversation before
                contacting a customer again.
              </p>
              <Link className="secondary-action mt-4" href="/admin/inbox">
                Review the inbox
              </Link>
            </section>
          )}
        </>
      )}
      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-navy">
            Client and cleaner matching
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            The existing engine checks eligibility, availability, recurring
            relationships, and cost. Employees can be assigned directly;
            independent cleaners receive an offer to accept.
          </p>
          <p className="mt-3 text-sm text-ink-2">
            {decisions[0]
              ? `Last recorded decision: ${formatDateTimeInZone(new Date(decisions[0].decided_at))}.`
              : "No recent matching decision is available here."}
          </p>
          <Link href="/admin/dispatch" className="secondary-action mt-5">
            Review matching exceptions
          </Link>
        </section>
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-navy">
            Reminders and follow-ups
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Scheduled workflows handle visit reminders, eligible lead
            follow-ups, and review requests. Consent and opt-outs remain part of
            the sending rules.
          </p>
          <p className="mt-3 text-sm font-semibold text-navy">
            {isMessagingEnabled()
              ? "Message sending is enabled in this deployment."
              : "Message sending is disabled in this deployment."}
          </p>
          <p className="mt-2 text-sm text-ink-2">
            Enabled settings do not establish successful delivery. The activity
            above shows recorded outcomes.
          </p>
        </section>
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-navy">Payments</h2>
          <p className="mt-3 text-sm font-semibold text-navy">
            {isBillingEnabled()
              ? "Billing is enabled in this deployment."
              : "Stripe payments are inactive."}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Payment activation is a separate launch step. This screen does not
            enable billing or charge a customer.
          </p>
        </section>
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-navy">
            The remaining booking gap
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            The public form currently records an inquiry. It still needs
            confirmed availability and a reservation flow before a new customer
            can move straight into automatic matching without the office
            creating a job.
          </p>
          <Link href="/admin/leads" className="secondary-action mt-5">
            Review current inquiries
          </Link>
        </section>
      </div>
    </>
  );
}
