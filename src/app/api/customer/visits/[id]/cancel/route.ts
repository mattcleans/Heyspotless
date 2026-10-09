import type { NextRequest } from "next/server";
import { cancelVisit } from "@/lib/customer/cancellation/route";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return cancelVisit(request, (await params).id, false);
}
