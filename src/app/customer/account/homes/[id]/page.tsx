import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { instructionsFor, isStoredHomeId } from "@/lib/customer/home-instructions";
import { HomeInstructionsForm } from "./home-instructions-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home instructions | Hey Spotless" };
export default async function HomeInstructionsPage({ params }: { params: Promise<{ id: string }> }) {
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  const customer = repo.isDemo ? await repo.getCustomerByProfile("demo") : profile?.role === "customer" ? await repo.getCustomerByProfile(profile.id) : null;
  if (!customer) return <section className="visit-feature"><h1 className="text-xl font-semibold text-navy">Your home instructions</h1><p className="mt-3 text-sm">Sign in with your client account to manage your home instructions.</p><Link href="/login?next=%2Fcustomer%2Faccount%2Fhomes" className="secondary-action mt-4 inline-flex">Sign in</Link></section>;
  const { id } = await params;
  if (!repo.isDemo && !isStoredHomeId(id)) notFound();
  const home = await repo.getProperty(id);
  if (!home || home.customerId !== customer.id) notFound();
  return <>
    <Link href="/customer/account/homes" className="text-sm underline">All your homes</Link>
    <h1 className="welcome-title mt-4">Home instructions</h1>
    <p className="mt-3 font-semibold text-navy">{home.street}</p><p className="mt-1 text-sm text-ink-2">{home.city}, {home.state} {home.zip}</p>
    <p className="mt-4 text-sm text-ink-2">Your assigned cleaner can see these details for this home. Tell them how to get in, where to park, and what to know about pets.</p>
    <HomeInstructionsForm homeId={home.id} initialInstructions={instructionsFor(home)} demo={repo.isDemo} />
    <p className="mt-5 text-sm text-ink-2">For a change to your address, rooms, or visit time, <a href="tel:+14692800397" className="underline">call the office</a>.</p>
  </>;
}
