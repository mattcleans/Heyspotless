import { ReschedulePage } from "@/lib/customer/reschedule/page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Reschedule visit | Hey Spotless" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ start?: string }>;
}) {
  return ReschedulePage({
    id: (await params).id,
    office: true,
    start: (await searchParams)?.start,
  });
}
