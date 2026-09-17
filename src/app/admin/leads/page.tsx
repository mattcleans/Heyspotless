import Link from "next/link";
import { PageHeader, Pill, Stat } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { formatCents, formatPct } from "@/lib/money";
import { formatPhone } from "@/lib/format";
import { formatDateTimeInZone } from "@/lib/time/zone";
import {
  formatMinutes,
  responseMinutes,
  responseStats,
  urgencyOf,
  waitingMinutes,
  type LeadRow,
} from "@/lib/growth/leads";
import { LeadStatus } from "./lead-status";

/**
 * The lead book, sorted by who has been waiting longest.
 *
 * NOT BY NEWEST. The build plan's largest lever is lead conversion, and what
 * loses a lead is silence — the enquiry that came in on Saturday is the one at
 * risk on Monday, not the one that arrived ten minutes ago. Sorting by recency
 * would put the least urgent thing at the top of the screen every time.
 *
 * The number at the top left is the one the phase is measured on. It is the
 * MEDIAN time to a human answer: the inline acknowledgement the booking form
 * sends does not count, because a KPI a robot can satisfy is not a KPI.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Leads — Spotless Ops" };

export default async function LeadsPage() {
  if (isDemoMode()) {
    return (
      <>
        <PageHeader eyebrow="Admin" title="Leads">
          Every enquiry, oldest unanswered first.
        </PageHeader>
        <div className="card p-8 text-center text-sm text-ink-3">
          Leads need a live database — every row in here came from somebody filling in the
          booking form.
        </div>
      </>
    );
  }

  const leads = await load();
  const now = new Date();
  const stats = responseStats(leads, now);

  const open = leads
    .filter((l) => waitingMinutes(l, now) !== null)
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  const rest = leads
    .filter((l) => waitingMinutes(l, now) === null)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

  return (
    <>
      <PageHeader eyebrow="Admin" title="Leads">
        Every enquiry from the booking widget, oldest unanswered first. The chase runs itself —
        three texts over three days — and stops the moment somebody here replies.
      </PageHeader>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Stat
          label="Median response"
          value={formatMinutes(stats.medianMinutes)}
          note="To a human reply. The acknowledgement text does not count."
          tone={
            stats.medianMinutes === null
              ? "default"
              : stats.medianMinutes <= 60
                ? "good"
                : stats.medianMinutes <= 240
                  ? "warn"
                  : "bad"
          }
        />
        <Stat
          label="Waiting now"
          value={String(stats.waiting)}
          note={
            stats.longestWaitingMinutes !== null
              ? `Longest ${formatMinutes(stats.longestWaitingMinutes)}`
              : "Nothing unanswered"
          }
          tone={stats.waiting > 0 ? "warn" : "good"}
        />
        <Stat
          label="Conversion"
          value={stats.conversionRate === null ? "—" : formatPct(stats.conversionRate, 0)}
          note="Won, of the leads that reached a decision."
        />
        <Stat label="Answered" value={String(stats.answered)} note="All time." />
      </div>

      {leads.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-3">
          Nothing yet. Point the Webflow site&apos;s booking button at{" "}
          <code className="font-mono text-xs">/book</code> and enquiries land here.
        </div>
      ) : (
        <>
          {open.length > 0 ? (
            <section className="mb-6">
              <p className="eyebrow mb-2">Waiting on us</p>
              <ul className="space-y-2">
                {open.map((lead) => (
                  <LeadCard key={lead.id} lead={lead} now={now} />
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <p className="eyebrow mb-2">Answered and closed</p>
            <ul className="space-y-2">
              {rest.map((lead) => (
                <LeadCard key={lead.id} lead={lead} now={now} />
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

function LeadCard({ lead, now }: { lead: LeadRow; now: Date }) {
  const waiting = waitingMinutes(lead, now);
  const answered = responseMinutes(lead);
  const urgency = urgencyOf(waiting);

  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "No name"}
            {lead.quotedPriceCents ? (
              <span className="nums ml-2 text-sm text-navy">
                {formatCents(lead.quotedPriceCents)}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-sm text-ink-3">
            {[
              lead.bedrooms !== null ? `${lead.bedrooms} bed` : null,
              lead.bathrooms !== null ? `${lead.bathrooms} bath` : null,
              lead.service,
              lead.frequency,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-3">
            {[lead.rawAddress, lead.zip].filter(Boolean).join(", ")}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            {[formatPhone(lead.phone), lead.email].filter(Boolean).join(" · ")}
            {lead.smsConsentAt ? "" : " · no SMS consent"}
          </p>
        </div>

        <div className="text-right">
          {waiting !== null ? (
            <Pill tone={urgency === "fresh" ? "good" : urgency === "slipping" ? "warn" : "bad"}>
              waiting {formatMinutes(waiting)}
            </Pill>
          ) : answered !== null ? (
            <Pill tone="neutral">answered in {formatMinutes(answered)}</Pill>
          ) : (
            <Pill tone="neutral">{lead.status}</Pill>
          )}
          <p className="mt-1 text-xs text-ink-3">{formatDateTimeInZone(lead.receivedAt)}</p>
          <p className="mt-0.5 text-xs text-ink-3">{lead.source}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Link
          href={`/admin/inbox?thread=${encodeURIComponent(`lead:${lead.id}`)}`}
          className="rounded-lg bg-navy px-3 py-1.5 text-xs font-semibold text-white"
        >
          Reply
        </Link>
        <LeadStatus leadId={lead.id} status={lead.status} />
      </div>
    </li>
  );
}

/**
 * Read as the signed-in admin, under row-level security. A lead carries a name,
 * an address and a phone number for somebody who is not yet a customer and
 * never agreed to be in anybody's database twice.
 */
async function load(): Promise<LeadRow[]> {
  const db = await createClient();

  const { data, error } = await db
    .from("leads")
    .select(
      "id, first_name, last_name, phone, email, raw_address, zip, status, source, " +
        "service, freq, bedrooms, bathrooms, quoted_price_cents, received_at, " +
        "first_response_at, sms_consent_at, attribution",
    )
    .order("received_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`leads: ${error.message}`);

  // Through `unknown`: the select names columns 0023 added, which the
  // client's generated row types do not know about.
  const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row["id"]),
    firstName: text(row["first_name"]),
    lastName: text(row["last_name"]),
    phone: text(row["phone"]),
    email: text(row["email"]),
    rawAddress: text(row["raw_address"]),
    zip: text(row["zip"]),
    status: String(row["status"]),
    source: String(row["source"]),
    service: text(row["service"]),
    frequency: text(row["freq"]),
    bedrooms: num(row["bedrooms"]),
    bathrooms: num(row["bathrooms"]),
    quotedPriceCents: num(row["quoted_price_cents"]),
    receivedAt: new Date(String(row["received_at"])),
    firstResponseAt: row["first_response_at"] ? new Date(String(row["first_response_at"])) : null,
    smsConsentAt: row["sms_consent_at"] ? new Date(String(row["sms_consent_at"])) : null,
    attribution:
      row["attribution"] && typeof row["attribution"] === "object"
        ? (row["attribution"] as Record<string, unknown>)
        : null,
  }));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
