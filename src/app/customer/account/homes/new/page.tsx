import Link from "next/link";
import { getRepository } from "@/lib/data";
import { HomeSetupForm } from "./home-setup-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Add your home | Hey Spotless" };
export default async function NewHomePage() {
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== "customer") return <section className="visit-feature"><h1 className="welcome-title">Use your Client account</h1><Link href="/login?next=%2Fcustomer%2Faccount%2Fhomes%2Fnew" className="primary-action mt-5 inline-flex">Sign in</Link></section>;
  const customer = repo.isDemo ? null : await repo.getCustomerByProfile(profile!.id);
  return <>
    <h1 className="welcome-title">Your home, ready to book.</h1>
    <p className="mt-3 text-sm text-ink-2">Save the address and rooms we’ll clean. Next, choose your service and review the price.</p>
    {!customer && <p className="mt-3 text-sm text-ink-2">Already clean with us? <a className="underline" href="tel:+14692800397">Call the office to connect your existing home and visits</a>.</p>}
    <HomeSetupForm needsContact={!customer} demo={repo.isDemo} />
  </>;
}
