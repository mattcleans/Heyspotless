import { ScheduleListPage } from "@/lib/customer/recurring/page";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return ScheduleListPage({ office: true, customerId: (await params).id });
}
