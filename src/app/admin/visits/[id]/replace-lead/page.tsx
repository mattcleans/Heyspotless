import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { crewReview } from "@/lib/crew/store";
import { isChoiceId } from "@/lib/customer/cleaner-choice/input";
import { ReplacementForm } from "./replacement-form";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Replace crew lead | Hey Spotless management",
};
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== "admin")
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to management</h1>
        <Link
          href="/login?next=%2Fadmin%2Fcleaner-requests"
          className="secondary-action mt-4"
        >
          Sign in
        </Link>
      </section>
    );
  if (!isChoiceId(id)) notFound();
  if (repo.isDemo)
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Replace crew lead</h1>
        <p className="preview-note mt-4">
          Live crew replacements need an authenticated database. Preview
          assignments cannot be changed.
        </p>
        <Link href="/admin/cleaner-requests" className="secondary-action mt-4">
          Back to cleaner requests
        </Link>
      </section>
    );
  const data = await crewReview(await createClient(), id);
  return (
    <>
      <Link
        href="/admin/cleaner-requests"
        className="inline-flex min-h-11 items-center text-sm underline"
      >
        Back to cleaner requests
      </Link>
      <h1 className="welcome-title mt-3">Replace crew lead</h1>
      <p className="mt-3 max-w-2xl text-sm text-ink-2">
        Resolve a client-declined lead while keeping teammates’ accepted
        assignments and pay. Work stays blocked until the actual backup is
        approved by the client.
      </p>
      <ReplacementForm jobId={id} data={data} />
      <Link href={`/admin/visits/${id}`} className="secondary-action mt-5">
        Review visit
      </Link>
    </>
  );
}
