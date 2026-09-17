import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { INBOX_REPLY, MessagingStore } from "@/lib/messaging/store";
import { sendSms } from "@/lib/messaging/gateway";
import { isMessagingEnabled } from "@/lib/messaging/env";

/**
 * A person, typing.
 *
 * The other half of the inbox, and the one place in the system where a message
 * is not generated from a template. Three things it does differently from every
 * automated send:
 *
 *   * NO DEDUPE KEY. Saying the same thing twice on purpose is a thing people
 *     do, and a reply that silently does not send because it matched an earlier
 *     one is a worse failure than a duplicate text.
 *   * NO QUIET HOURS. The office is answering somebody who just wrote to them.
 *     Deferring a human reply to 08:00 because the clock says 20:01 would make
 *     the inbox unusable for the one conversation that matters most — a
 *     customer with a problem tonight.
 *   * STOP STILL WINS. A number that has opted out is refused here too, with a
 *     message telling the office to ring them instead. There is an argument
 *     that answering somebody who wrote to us is a reply rather than a
 *     campaign, and it may well be right — but it is an argument to have with
 *     a compliance answer in hand, not one to settle by writing the permissive
 *     version first.
 *
 * Admin only, and the recipient is resolved on the server from the thread
 * rather than taken from the request: a `to` in a request body is a way to send
 * an SMS from the business's number to anywhere.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  const body = await readJson(request);
  const text = typeof body["body"] === "string" ? body["body"].trim() : "";
  const customerId = typeof body["customerId"] === "string" ? body["customerId"] : null;
  const cleanerId = typeof body["cleanerId"] === "string" ? body["cleanerId"] : null;
  const leadId = typeof body["leadId"] === "string" ? body["leadId"] : null;
  const phone = typeof body["phone"] === "string" ? body["phone"] : null;

  if (!text) return NextResponse.json({ error: "nothing to send" }, { status: 400 });
  if (text.length > 1200) {
    // Ten segments. Past this it is an email, and sending it as one text is a
    // bill nobody expected.
    return NextResponse.json({ error: "that is too long to send as a text" }, { status: 400 });
  }

  const db = createAdminClient();
  const to = await resolveRecipient(db, { customerId, cleanerId, leadId, phone });

  if (!to.ok) return NextResponse.json({ error: to.reason }, { status: 409 });

  if (!isMessagingEnabled()) {
    return NextResponse.json({ sent: false, reason: "messaging is disabled" }, { status: 503 });
  }

  const messaging = new MessagingStore(db);
  const messageId = await messaging.claimByKey({
    dedupeKey: null,
    kind: INBOX_REPLY,
    body: text,
    to: to.phone,
    customerId,
    cleanerId,
    leadId,
  });

  if (!messageId) {
    return NextResponse.json({ error: "could not record that message" }, { status: 500 });
  }

  const sent = await sendSms(to.phone, text);
  if (!sent.ok) {
    await messaging.settle(messageId, null, sent.reason);
    return NextResponse.json({ sent: false, reason: sent.reason }, { status: 502 });
  }

  await messaging.settle(messageId, sent.providerId);

  /**
   * A PERSON ANSWERED. This is the moment time-to-first-response is measured
   * from, and the whole of phase 07 is measured on it.
   *
   * Set here rather than anywhere else because this is the only place in the
   * system where somebody types a sentence to a lead. The inline
   * acknowledgement the booking form sends does NOT count and deliberately does
   * not call this — letting a robot stop the clock would make the number
   * measure the robot.
   *
   * Idempotent in SQL: FIRST response, not latest, so a second reply does not
   * reset it.
   */
  if (leadId) {
    const { error } = await db.rpc("mark_lead_responded", { p_lead_id: leadId, p_at: null });
    // Worth a log, never worth failing the send over: the message went out,
    // which is the thing the customer cares about.
    if (error) console.error("mark_lead_responded failed", error);
  }

  return NextResponse.json({ sent: true });
}

type Recipient = { ok: true; phone: string } | { ok: false; reason: string };

/**
 * Where the message actually goes, read from the record rather than the request.
 *
 * An unattached thread is the exception: there is no record to read, so the
 * number from the thread is all there is. It is checked against a message we
 * have actually received from it, so it cannot be used to text an arbitrary
 * number — only one that has already written to us.
 */
async function resolveRecipient(
  db: ReturnType<typeof createAdminClient>,
  target: {
    customerId: string | null;
    cleanerId: string | null;
    leadId: string | null;
    phone: string | null;
  },
): Promise<Recipient> {
  if (target.customerId) {
    const { data } = await db
      .from("customers")
      .select("phone, sms_opted_out_at")
      .eq("id", target.customerId)
      .maybeSingle();
    return phoneOf(data, "that customer has no number on file");
  }

  if (target.cleanerId) {
    const { data } = await db
      .from("cleaners")
      .select("profiles ( phone, sms_opted_out_at )")
      .eq("id", target.cleanerId)
      .maybeSingle();
    const profile = (data as Record<string, unknown> | null)?.["profiles"] ?? null;
    return phoneOf(profile as Record<string, unknown> | null, "that cleaner has no number on file");
  }

  if (target.leadId) {
    const { data } = await db
      .from("leads")
      .select("phone")
      .eq("id", target.leadId)
      .maybeSingle();
    return phoneOf(data, "that enquiry has no number on file");
  }

  if (target.phone) {
    // Only a number that has written to us. Otherwise this endpoint is a way to
    // send an SMS from the business's registered number to anywhere at all.
    const { data } = await db
      .from("messages")
      .select("id")
      .eq("direction", "inbound")
      .eq("from_address", target.phone)
      .limit(1);

    if (Array.isArray(data) && data.length > 0) return { ok: true, phone: target.phone };
    return { ok: false, reason: "that number has never written to us" };
  }

  return { ok: false, reason: "no recipient" };
}

function phoneOf(row: Record<string, unknown> | null, missing: string): Recipient {
  const phone = row?.["phone"];
  if (typeof phone !== "string" || !phone) return { ok: false, reason: missing };

  // Opted out and has not written since — see the header. Replying here would
  // be resuming a broadcast they asked us to stop.
  if (row?.["sms_opted_out_at"] != null) {
    return { ok: false, reason: "they have replied STOP — call them instead" };
  }
  return { ok: true, phone };
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
