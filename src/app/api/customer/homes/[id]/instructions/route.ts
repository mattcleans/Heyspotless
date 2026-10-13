import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import {
  instructionsFor,
  isStoredHomeId,
  parseHomeInstructions,
} from "@/lib/customer/home-instructions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const repo = await getRepository();
  if (repo.isDemo)
    return NextResponse.json(
      {
        error:
          "Preview instructions cannot be saved. Sign in to manage your own home.",
      },
      { status: 409 },
    );
  const profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in again to save. Your edits are still here." },
      { status: 401 },
    );
  if (profile.role !== "customer")
    return NextResponse.json(
      { error: "Use your client account to update home instructions." },
      { status: 403 },
    );
  const customer = await repo.getCustomerByProfile(profile.id);
  if (!customer)
    return NextResponse.json(
      { error: "Call the office to connect your account to your home." },
      { status: 403 },
    );
  const { id } = await params;
  if (!isStoredHomeId(id))
    return NextResponse.json(
      { error: "Choose a home from your account." },
      { status: 400 },
    );
  const property = await repo.getProperty(id);
  if (!property || property.customerId !== customer.id)
    return NextResponse.json(
      { error: "This home is not available in your account." },
      { status: 404 },
    );
  let values, expected;
  try {
    const body = await request.json().catch(() => null);
    values = parseHomeInstructions(body?.instructions);
    expected = parseHomeInstructions(body?.expected, false);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Check your home instructions.",
      },
      { status: 400 },
    );
  }
  const db = await createClient();
  const { data, error } = await db.rpc("set_my_home_instructions", {
    p_property_id: id,
    p_gate_code: values.gateCode,
    p_access_notes: values.accessNotes,
    p_parking_notes: values.parkingNotes,
    p_pets: values.pets,
    p_expected: expected,
  });
  if (["PT409", "40001", "40P01"].includes(error?.code ?? "")) {
    const latest = await repo.getProperty(id);
    return NextResponse.json(
      {
        error:
          "These instructions changed since you opened this page. Review the latest details before saving your edits.",
        latest:
          latest?.customerId === customer.id
            ? instructionsFor(latest)
            : undefined,
      },
      { status: 409 },
    );
  }
  if (error)
    return NextResponse.json(
      {
        error:
          error.code === "42501"
            ? "This home is no longer available in your account. Your edits are still here."
            : "We could not confirm the save. Your edits are still here. Try again or call the office.",
      },
      { status: error.code === "42501" ? 403 : 500 },
    );
  try {
    return NextResponse.json({
      saved: true,
      instructions: parseHomeInstructions(data),
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "We could not confirm the save. Your edits are still here. Try again or call the office.",
      },
      { status: 500 },
    );
  }
}
