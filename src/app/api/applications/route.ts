import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";
import { APPLICANT_SMS_CONSENT_TEXT } from "@/lib/growth/consent";
import { SCREEN_QUESTIONS } from "@/lib/recruiting/screen";

/**
 * Somebody wants to clean.
 *
 * Public, like the booking form and the ratings endpoint, and for the same
 * reason: an application behind a login is an application nobody finishes.
 *
 * WHAT A FORGED REQUEST BUYS. A fake application in the review queue. It cannot
 * choose its own status, score or cleaner id — `record_application` writes
 * those itself, which is why the browser talks to a function rather than to the
 * table. Arriving pre-approved is the attack this shape prevents.
 *
 * The screen answers are stored as asked. They are read by a person, and in
 * time by the screening tool; nothing branches on them here, which is why they
 * are a jsonb blob rather than fifteen columns that will be wrong by spring.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json({ error: "applications need a live database" }, { status: 503 });
  }

  const body = await readJson(request);

  const firstName = str(body["firstName"], 80);
  const lastName = str(body["lastName"], 80);
  const phone = str(body["phone"], 40);

  if (!firstName || !phone) {
    return NextResponse.json({ error: "a name and a phone number are needed" }, { status: 400 });
  }

  // Only the questions we asked. An answer to a key that is not on the form is
  // somebody else's payload, and storing it means it turns up in the review
  // queue looking like something a person typed.
  const rawAnswers = (body["answers"] ?? {}) as Record<string, unknown>;
  const answers: Record<string, string> = {};
  for (const question of SCREEN_QUESTIONS) {
    const value = rawAnswers[question.key];
    if (typeof value === "string" && value.trim()) {
      answers[question.key] = value.trim().slice(0, 2000);
    }
  }

  const zips = Array.isArray(body["serviceZips"])
    ? (body["serviceZips"] as unknown[])
        .filter((z): z is string => typeof z === "string")
        .map((z) => z.trim())
        .filter((z) => /^\d{5}$/.test(z))
        .slice(0, 25)
    : [];

  const consented = body["smsConsent"] === true;

  const { data, error } = await createAdminClient().rpc("record_application", {
    p_first_name: firstName,
    p_last_name: lastName,
    p_email: str(body["email"], 200),
    p_phone: phone,
    p_years_experience: num(body["yearsExperience"], 0, 60),
    p_has_vehicle: bool(body["hasVehicle"]),
    p_work_authorized: bool(body["workAuthorized"]),
    p_service_zips: zips,
    p_desired_type: "contractor_1099",
    p_has_own_insurance: bool(body["hasOwnInsurance"]),
    p_referral_source: str(body["referralSource"], 200),
    p_screen_answers: Object.keys(answers).length > 0 ? answers : null,
    p_sms_consent_text: consented ? APPLICANT_SMS_CONSENT_TEXT : null,
  });

  if (error || typeof data !== "string") {
    console.error("record_application failed", error);
    return NextResponse.json({ error: "could not save that" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function num(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
