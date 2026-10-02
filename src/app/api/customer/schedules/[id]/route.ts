import type { NextRequest } from "next/server";
import { changeRecurringSchedule } from "@/lib/customer/recurring/route";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return changeRecurringSchedule(request, (await params).id, false);
}
