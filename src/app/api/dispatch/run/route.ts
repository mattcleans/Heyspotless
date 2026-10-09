import { NextResponse, type NextRequest } from "next/server";
import { cronSecretMatches } from "@/lib/stripe/env";
import { runDispatch } from "@/lib/dispatch/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel invokes GET; manual operations may continue to use POST. */
export async function POST(request: NextRequest) {
  const presented = request.headers.get("x-cron-secret")
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!cronSecretMatches(presented)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await runDispatch(request.nextUrl.origin));
}
export const GET = POST;
