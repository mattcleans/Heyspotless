import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { isChoiceId } from "@/lib/customer/cleaner-choice/input";
import {
  loadVisitChoice,
  type VisitChoice,
} from "@/lib/customer/cleaner-choice/store";
import { CleanerChoiceForm } from "./cleaner-choice-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Choose your cleaner | Hey Spotless" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ preferred?: string }>;
}) {
  const { id } = await params,
    q = await searchParams,
    repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== "customer")
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in with your client account</h1>
        <Link
          className="secondary-action mt-4 inline-flex"
          href={`/login?next=${encodeURIComponent(`/customer/visits/${id}/cleaner`)}`}
        >
          Sign in
        </Link>
      </section>
    );
  if (!repo.isDemo && !isChoiceId(id)) notFound();
  const customer = await repo.getCustomerByProfile(profile?.id ?? "demo"),
    job = await repo.getJob(id);
  if (!customer || !job || (!repo.isDemo && job.customerId !== customer.id))
    notFound();
  const home = await repo.getProperty(job.propertyId);
  if (!home)
    throw new Error("Home details could not be loaded. Please refresh.");
  let choice: VisitChoice, people: { id: string; name: string }[];
  if (repo.isDemo) {
    choice = {
      status: job.status,
      started: job.status === "in_progress",
      preferredCleanerId: null,
      assigned: null,
      request: null,
      backup: null,
    };
    people = (await repo.listCleaners())
      .slice(0, 3)
      .map((c) => ({ id: c.id, name: c.name }));
  } else {
    const db = await createClient();
    const loaded = await loadVisitChoice(db, id);
    if (!loaded) notFound();
    choice = loaded;
    const directory = new CleanerDirectory(db);
    people = (await directory.servingZip(home.zip, 24)).map((c) => ({
      id: c.id,
      name: c.fullName,
    }));
    if (isChoiceId(q?.preferred)) {
      const selected = await directory.get(q.preferred);
      if (
        selected &&
        (selected.serviceZips.length === 0 ||
          selected.serviceZips.includes(home.zip))
      )
        people = [
          { id: selected.id, name: selected.fullName },
          ...people.filter((p) => p.id !== selected.id),
        ].slice(0, 24);
    }
  }
  return (
    <>
      <Link
        href={`/customer/visits/${id}`}
        className="mb-5 inline-flex min-h-11 items-center text-sm underline"
      >
        Back to visit
      </Link>
      <h1 className="welcome-title">Your cleaner for this visit</h1>
      <p className="mt-2 text-sm text-ink-2">
        {home.street}, {home.city}
      </p>
      <CleanerChoiceForm
        jobId={id}
        choice={choice}
        people={people}
        selectedId={isChoiceId(q?.preferred) ? q.preferred : undefined}
        preview={repo.isDemo}
      />
    </>
  );
}
