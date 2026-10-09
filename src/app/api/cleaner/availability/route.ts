import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { parseAvailability } from "@/lib/cleaners/availability-input";

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  if (repo.isDemo) return NextResponse.json({ error: "Preview hours cannot be saved." }, { status: 409 });
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Sign in again to save your hours." }, { status: 401 });
  if (profile.role !== "cleaner") return NextResponse.json({ error: "Sign in with your cleaner account." }, { status: 403 });
  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner || cleaner.status !== "active") return NextResponse.json({ error: "Contact the office to check your cleaner account." }, { status: 403 });
  let windows;
  try {
    const body: unknown = await request.json();
    windows = parseAvailability(body && typeof body === "object" ? (body as Record<string, unknown>).windows : null);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Check your working hours." }, { status: 400 });
  }
  const db = await createClient();
  const { error } = await db.rpc("set_my_availability", { p_windows: windows });
  if (error) return NextResponse.json({ error: "Your hours could not be saved. Your edits are still here. Try again or call the office." }, { status: 500 });
  return NextResponse.json({ saved: true });
}
