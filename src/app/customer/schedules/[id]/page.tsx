import { SchedulePage } from "@/lib/customer/recurring/page";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  return SchedulePage({
    id: (await params).id,
    office: false,
    draft: (await searchParams).draft,
  });
}
