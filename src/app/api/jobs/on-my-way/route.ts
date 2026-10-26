import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { AutomationStore } from "@/lib/automations/store";
import { MessagingStore, ON_MY_WAY } from "@/lib/messaging/store";
import { onMyWayMessage } from "@/lib/messaging/templates";
import { isMessagingEnabled } from "@/lib/messaging/env";
import { sendSms } from "@/lib/messaging/gateway";
import { arrivalTextReceipt, unconfirmedArrivalText, type ArrivalTextReceipt } from "@/lib/messaging/arrival-receipt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const validJob = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function reply(receipt: ArrivalTextReceipt, status = 200) {
  return NextResponse.json({ ...receipt, sent: receipt.state === "accepted" }, { status, headers: { "cache-control": "private, no-store" } });
}
async function context(jobId: string) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return { response: reply({ state: "sign_in", message: "Sign in again to check your arrival text." }, 401) };
  if (profile.role !== "cleaner") return { response: reply({ state: "unavailable", message: "Cleaner access is required." }, 403) };
  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return { response: reply({ state: "unavailable", message: "Your Cleaner account could not be verified." }, 403) };
  const db = createAdminClient();
  const contact = (await new AutomationStore(db).contactsFor([jobId])).get(jobId);
  if (!contact || contact.cleanerId !== cleaner.id) return { response: reply({ state: "unavailable", message: "This visit is no longer available to you. Refresh the visit or contact the office." }, 409) };
  return { cleaner, contact, messaging: new MessagingStore(db) };
}

/** Read a durable receipt after reload/lost response. Never sends a text. */
export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!validJob(jobId)) return reply({ state: "unavailable", message: "Choose a valid visit." }, 400);
  try {
    const ctx = await context(jobId);
    if (ctx.response) return ctx.response;
    const receipt = await ctx.messaging.onMyWayReceipt(jobId, ctx.cleaner.id);
    if (receipt.state === "not_requested" && (!isMessagingEnabled() || ctx.contact.customerOptedOut || !ctx.contact.customerPhone || ctx.contact.status !== "assigned")) return reply({ state: "unavailable", message: "An arrival text cannot be requested for this visit. Contact the office if the Client needs an update." });
    return reply(receipt);
  } catch { return reply(unconfirmedArrivalText(), 503); }
}

/** One request per visit; a saved request is never treated as proof of delivery. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { const data: unknown = await request.json(); body = data && typeof data === "object" ? data as Record<string, unknown> : {}; }
  catch { body = {}; }
  const jobId = body.jobId;
  if (!validJob(jobId)) return reply({ state: "unavailable", message: "Choose a valid visit." }, 400);
  try {
    const ctx = await context(jobId);
    if (ctx.response) return ctx.response;
    const { cleaner, contact, messaging } = ctx;
    const existing = await messaging.onMyWayReceipt(jobId, cleaner.id);
    if (existing.state !== "not_requested") return reply(existing);
    if (contact.status !== "assigned") return reply({ state: "unavailable", message: "This visit is not waiting for an arrival update. Refresh the visit." }, 409);
    const approval = await (await createClient()).from("visit_backup_status")
      .select("approved,unambiguous").eq("job_id", jobId).limit(2);
    if (approval.error || !Array.isArray(approval.data)) return reply({ state: "unavailable", message: "Client approval could not be checked. Contact the office before sending an arrival update." }, 503);
    if (approval.data.length > 1 || approval.data.some(a => a.approved !== true || a.unambiguous !== true)) return reply({ state: "unavailable", message: "The Client still needs to approve this Cleaner. Contact the office before sending an arrival update." }, 409);
    if (contact.customerOptedOut || !contact.customerPhone || !isMessagingEnabled()) return reply({ state: "unavailable", message: "An arrival text cannot be requested for this visit. Contact the office if the Client needs an update." });
    const minutesAway = typeof body.minutesAway === "number" && Number.isFinite(body.minutesAway) ? Math.max(0, Math.min(120, Math.round(body.minutesAway))) : null;
    const text = onMyWayMessage({ customerFirstName: contact.customerFirstName, cleanerFirstName: cleaner.name.split(" ")[0] || "your cleaner", minutesAway });
    const messageId = await messaging.claimByKey({ dedupeKey: `job:${jobId}:${ON_MY_WAY}`, kind: ON_MY_WAY, body: text, to: contact.customerPhone, customerId: contact.customerId, cleanerId: cleaner.id, jobId });
    if (!messageId) {
      const receipt = await messaging.onMyWayReceipt(jobId, cleaner.id);
      return reply(receipt.state === "not_requested" ? unconfirmedArrivalText() : receipt);
    }
    const sent = await sendSms(contact.customerPhone, text);
    if (!sent.ok) {
      await messaging.settle(messageId, null, sent.reason);
      return reply(unconfirmedArrivalText(), 502);
    }
    await messaging.settle(messageId, sent.providerId);
    return reply(arrivalTextReceipt({ providerId: sent.providerId, failedReason: null }));
  } catch { return reply(unconfirmedArrivalText(), 503); }
}
