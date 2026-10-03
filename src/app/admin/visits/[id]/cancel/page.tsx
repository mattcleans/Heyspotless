import { CancellationPage } from "@/lib/customer/cancellation/page";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Visit cancellation | Hey Spotless management",
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ choice?: string }>;
}) {
  return CancellationPage({
    id: (await params).id,
    office: true,
    choice: (await searchParams)?.choice,
  });
}
