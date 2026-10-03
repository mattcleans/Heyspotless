import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { crewAccess, crewFailure } from "@/lib/crew/access";
import { parseCrewAnswer, toCrewReceipt } from "@/lib/crew/types";
export async function POST(request: NextRequest) {
  const access = await crewAccess("cleaner");
  if (access) return access;
  let b;
  try {
    b = parseCrewAnswer(await request.json());
  } catch {
    return crewFailure({ code: "22023" });
  }
  const { data, error } = await (
    await createClient()
  ).rpc("respond_my_crew_lead_offer", { p_id: b.id, p_accept: b.accept });
  if (error) return crewFailure(error);
  try {
    const receipt = toCrewReceipt(data);
    if (
      receipt.id !== b.id ||
      receipt.type !== "contractor_1099" ||
      receipt.state === "review" ||
      (b.accept && receipt.state === "declined") ||
      (!b.accept && receipt.state === "accepted")
    )
      return crewFailure(null);
    return NextResponse.json(receipt);
  } catch {
    return crewFailure(null);
  }
}
