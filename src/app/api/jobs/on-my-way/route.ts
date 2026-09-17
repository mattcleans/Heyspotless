import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { AutomationStore } from "@/lib/automations/store";
import { MessagingStore, ON_MY_WAY } from "@/lib/messaging/store";
import { onMyWayMessage } from "@/lib/messaging/templates";
import { sendSms } from "@/lib/messaging/gateway";
import { isMessagingEnabled } from "@/lib/messaging/env";

/**
 * "On my way."
 *
 * The one customer-facing message a cleaner sends herself, and the only one in
 * the system with no opt-out line and no brand preamble: she is fifteen minutes
 * from the door, the message exists so nobody is startled by a stranger in the
 * driveway, and there is no version of this business where the right answer to
 * it is "unsubscribe".
 *
 * ONE PER VISIT. The key is the job, so tapping it twice sends one text. That
 * is a deliberate limit rather than an oversight: a second "on my way" twenty
 * minutes after the first does not tell the customer anything the first did
 * not, and a cleaner stuck in traffic needs to say something specific, which
 * is a conversation in the inbox rather than a button.
 *
 * Sent as the cleaner but recorded against the customer's thread, because that
 * is where the office needs to see it when the customer replies to it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const jobId = typeof body["jobId"] === "string" ? body["jobId"] : null;
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const minutesAway =
    typeof body["minutesAway"] === "number" && Number.isFinite(body["minutesAway"])
      ? Math.max(0, Math.min(120, Math.round(body["minutesAway"])))
      : null;

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return NextResponse.json({ error: "no cleaner record" }, { status: 403 });

  const db = createAdminClient();
  const contacts = await new AutomationStore(db).contactsFor([jobId]);
  const contact = contacts.get(jobId);

  // Not her job, or no job. The same answer for both, like the completion
  // route: an id somebody is guessing at should not learn which it was.
  if (!contact || contact.cleanerId !== cleaner.id) {
    return NextResponse.json({ error: "that job is not yours" }, { status: 409 });
  }

  if (contact.customerOptedOut) {
    return NextResponse.json({ sent: false, reason: "customer opted out" });
  }
  if (!contact.customerPhone) {
    return NextResponse.json({ sent: false, reason: "no phone on file" });
  }
  if (!isMessagingEnabled()) {
    return NextResponse.json({ sent: false, reason: "messaging is disabled" });
  }

  const messaging = new MessagingStore(db);
  const text = onMyWayMessage({
    customerFirstName: contact.customerFirstName,
    cleanerFirstName: cleaner.name.split(" ")[0] || "your cleaner",
    minutesAway,
  });

  const messageId = await messaging.claimByKey({
    dedupeKey: `job:${jobId}:${ON_MY_WAY}`,
    kind: ON_MY_WAY,
    body: text,
    to: contact.customerPhone,
    customerId: contact.customerId,
    cleanerId: cleaner.id,
    jobId,
  });

  // Already told them. Answered as a success, because from her side it is one:
  // the customer knows she is coming, which is the entire point of the button.
  if (!messageId) return NextResponse.json({ sent: true, already: true });

  const sent = await sendSms(contact.customerPhone, text);
  if (!sent.ok) {
    await messaging.settle(messageId, null, sent.reason);
    return NextResponse.json({ sent: false, reason: sent.reason }, { status: 502 });
  }

  await messaging.settle(messageId, sent.providerId);
  return NextResponse.json({ sent: true });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
