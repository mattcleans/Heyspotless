import { CancellationPage } from "@/lib/customer/cancellation/page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Manage appointment | Hey Spotless" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ choice?: string }>;
}) {
  return CancellationPage({
    id: (await params).id,
    office: false,
    choice: (await searchParams)?.choice,
  });
}
