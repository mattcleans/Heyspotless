import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { parseHomeSetup, savedHome } from "@/lib/customer/home-setup";
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({ error: "Open home setup in this app and try again." }, { status: 403 });
  try {
    const repo = await getRepository(), profile = await repo.getCurrentProfile();
    if (!profile) return NextResponse.json({ error: "Sign in again to save your home." }, { status: 401 });
    if (profile.role !== "customer") return NextResponse.json({ error: "Use your Client account to save a home." }, { status: 403 });
    if (repo.isDemo) return NextResponse.json({ error: "Sample homes cannot be saved." }, { status: 409 });
    let body;
    try { body = parseHomeSetup(await request.json()); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Check your home details." }, { status: 400 }); }
    const db = await createClient();
    const result = await db.rpc("save_my_home", { p_id: body.id, p_home: body.home, p_contact: body.contact });
    if (result.error) {
      const code = result.error.code;
      const [status, error] = code === "42501" ? [403, "Confirm your email and sign in with your Client account before saving."]
        : code === "PHC01" ? [409, "Your email already has a Client record. Call 469-280-0397 so the office can connect your existing visits and home."]
        : code === "PT409" ? [409, "This saved home or review changed. Open Your homes to check the latest details before starting again."]
        : code === "22023" ? [400, "Check the address, room counts and contact details."]
        : [503, "We could not confirm the save. Retry Save home with these same reviewed details."];
      return NextResponse.json({ error }, { status: Number(status) });
    }
    return NextResponse.json(savedHome(result.data, body));
  } catch {
    return NextResponse.json({ error: "We could not confirm the save. Retry Save home with these same reviewed details." }, { status: 503 });
  }
}
