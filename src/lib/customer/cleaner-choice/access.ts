import "server-only";
import { getRepository } from "@/lib/data";
import { NextResponse } from "next/server";
import { isChoiceId } from "./input";
export async function clientVisitAccess(id: string) {
  const repo = await getRepository();
  if (repo.isDemo)
    return {
      error: NextResponse.json(
        {
          error:
            "Preview changes cannot be saved. Sign in to manage your own visit.",
        },
        { status: 409 },
      ),
    };
  const profile = await repo.getCurrentProfile();
  if (!profile)
    return {
      error: NextResponse.json(
        { error: "Sign in again. Your choice is still here." },
        { status: 401 },
      ),
    };
  if (profile.role !== "customer")
    return {
      error: NextResponse.json(
        { error: "Use your client account to choose a cleaner." },
        { status: 403 },
      ),
    };
  if (!isChoiceId(id))
    return {
      error: NextResponse.json(
        { error: "Choose a visit from your account." },
        { status: 400 },
      ),
    };
  const customer = await repo.getCustomerByProfile(profile.id);
  if (!customer)
    return {
      error: NextResponse.json(
        { error: "Call the office to connect your account to your visits." },
        { status: 403 },
      ),
    };
  const job = await repo.getJob(id);
  if (!job || job.customerId !== customer.id)
    return {
      error: NextResponse.json(
        { error: "This visit is not available in your account." },
        { status: 404 },
      ),
    };
  return { job };
}
export function choiceFailure(error: { code?: string } | null) {
  const code = error?.code;
  const status =
    code === "42501"
      ? 403
      : ["PT409", "40001", "40P01", "23514"].includes(code ?? "")
        ? 409
        : code === "22023"
          ? 400
          : 500;
  const message =
    code === "42501"
      ? "This visit is no longer available in your account."
      : ["PT409", "40001", "40P01"].includes(code ?? "")
        ? "The visit or choice changed. Refresh and review the latest details before trying again."
        : code === "23514"
          ? "The requested cleaner is not currently eligible. Review matching before applying this preference."
          : "We could not confirm the save. Your choice is still here. Try again or call the office.";
  return NextResponse.json({ error: message }, { status });
}
