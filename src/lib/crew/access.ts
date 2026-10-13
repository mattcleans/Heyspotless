import "server-only";
import { NextResponse } from "next/server";
import { getRepository } from "@/lib/data";
export async function crewAccess(role: "admin" | "cleaner") {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in again to continue." },
      { status: 401 },
    );
  if (profile.role !== role)
    return NextResponse.json(
      { error: "Use the account for this action." },
      { status: 403 },
    );
  if (repo.isDemo)
    return NextResponse.json(
      { error: "Preview assignments cannot be changed." },
      { status: 409 },
    );
  return null;
}
export function crewFailure(error: { code?: string } | null) {
  const code = error?.code;
  if (code === "42501")
    return NextResponse.json(
      { error: "Use your connected account to review this replacement." },
      { status: 403 },
    );
  if (["PT409", "40001", "40P01", "PCP01", "23514"].includes(code ?? ""))
    return NextResponse.json(
      {
        error:
          "The crew, choice or availability changed. Refresh and review before trying again.",
      },
      { status: 409 },
    );
  if (code === "22023")
    return NextResponse.json(
      { error: "Check the replacement details." },
      { status: 400 },
    );
  return NextResponse.json(
    {
      error:
        "We could not confirm the save. Check your connection and retry the same action.",
    },
    { status: 500 },
  );
}
