import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { crewAccess, crewFailure } from "@/lib/crew/access";
import { parseCrewAction, toCrewReceipt, toCrewQuote } from "@/lib/crew/types";
export async function POST(request: NextRequest) {
  const access = await crewAccess("admin");
  if (access) return access;
  let b;
  try {
    b = parseCrewAction(await request.json());
  } catch {
    return crewFailure({ code: "22023" });
  }
  const db = await createClient();
  const result =
    b.action === "quote"
      ? await db.rpc("quote_crew_lead_replacement", {
          p_job_id: b.jobId,
          p_cleaner_id: b.cleanerId,
        })
      : await db.rpc(
          b.action === "confirm"
            ? "confirm_crew_lead_replacement"
            : "withdraw_crew_lead_offer",
          { p_id: b.id },
        );
  if (result.error) return crewFailure(result.error);
  try {
    const receipt =
      b.action === "quote"
        ? toCrewQuote(result.data)
        : toCrewReceipt(result.data);
    if (b.action === "quote" ? receipt.jobId !== b.jobId : receipt.id !== b.id)
      return crewFailure(null);
    return NextResponse.json(receipt);
  } catch {
    return crewFailure(null);
  }
}
