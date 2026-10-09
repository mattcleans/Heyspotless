import { ScheduleListPage } from "@/lib/customer/recurring/page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Recurring schedules | Hey Spotless" };
export default async function Page() {
  return ScheduleListPage({});
}
