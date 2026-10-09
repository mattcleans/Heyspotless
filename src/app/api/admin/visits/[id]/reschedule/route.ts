import type { NextRequest } from "next/server";
import { rescheduleVisit } from "@/lib/customer/reschedule/route";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return rescheduleVisit(request, (await params).id, true);
}
