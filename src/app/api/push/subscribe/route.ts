import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { PushStore } from "@/lib/push/store";
import { isPushEnabled, vapidKeys } from "@/lib/push/vapid";

/**
 * "Notify me about offers."
 *
 * GET hands the browser the public key it needs to subscribe — the browser will
 * not create a subscription without it, and hard-coding it in client JavaScript
 * would mean a key rotation is a deploy of the front end.
 *
 * POST saves what the browser came back with. The profile comes from the
 * session, never from the request: a subscription in a body with a profile id
 * beside it is a way to route somebody else's offers to your phone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = vapidKeys();
  if (!keys || !isPushEnabled()) {
    return NextResponse.json({ enabled: false });
  }
  return NextResponse.json({ enabled: true, publicKey: keys.publicKey });
}

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await readJson(request);
  const subscription = (body["subscription"] ?? {}) as Record<string, unknown>;
  const endpoint = typeof subscription["endpoint"] === "string" ? subscription["endpoint"] : null;

  if (!endpoint) return NextResponse.json({ error: "no endpoint" }, { status: 400 });

  const keys = (subscription["keys"] ?? {}) as Record<string, unknown>;

  await new PushStore(createAdminClient()).save({
    profileId: profile.id,
    endpoint,
    p256dh: typeof keys["p256dh"] === "string" ? keys["p256dh"] : null,
    auth: typeof keys["auth"] === "string" ? keys["auth"] : null,
    // Which device this is, for whoever is working out why one phone rings and
    // the other does not.
    userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
  });

  return NextResponse.json({ subscribed: true });
}

export async function DELETE(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await readJson(request);
  const endpoint = typeof body["endpoint"] === "string" ? body["endpoint"] : null;
  if (!endpoint) return NextResponse.json({ error: "no endpoint" }, { status: 400 });

  await new PushStore(createAdminClient()).remove(endpoint);
  return NextResponse.json({ unsubscribed: true });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
