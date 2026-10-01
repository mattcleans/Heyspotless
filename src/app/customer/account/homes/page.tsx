import Link from "next/link";
import { getRepository } from "@/lib/data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your homes | Hey Spotless" };
export default async function HomesPage() {
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  const customer = repo.isDemo ? await repo.getCustomerByProfile("demo") : profile?.role === "customer" ? await repo.getCustomerByProfile(profile.id) : null;
  const homes = customer ? await repo.listProperties(customer.id) : [];
  return <>
    <h1 className="welcome-title">Your homes</h1>
    <p className="mt-3 text-sm text-ink-2">Keep entry, parking, and pet instructions ready for your assigned cleaner.</p>
    {!customer ? <section className="visit-feature mt-5"><h2 className="font-semibold text-navy">Connect your account</h2><p className="mt-2 text-sm text-ink-2">Sign in with your client account. Call the office if your home does not appear.</p><Link href="/login?next=%2Fcustomer%2Faccount%2Fhomes" className="secondary-action mt-3 inline-flex">Sign in</Link></section>
      : homes.length ? <ul className="mt-5 space-y-3">{homes.map(home => <li key={home.id} className="visit-feature">
        <h2 className="text-lg font-semibold text-navy">{home.street}</h2><p className="mt-1 text-sm text-ink-2">{home.city}, {home.state} {home.zip}</p>
        <Link href={`/customer/account/homes/${encodeURIComponent(home.id)}`} className="secondary-action mt-4 inline-flex">Edit home instructions<span className="sr-only"> for {home.street}</span></Link>
      </li>)}</ul> : <section className="visit-feature mt-5"><h2 className="font-semibold text-navy">No homes connected yet</h2><p className="mt-2 text-sm text-ink-2">If you already clean with us, call the office to connect your home. For a new home, <Link href="/book" className="underline">request a clean</Link>.</p></section>}
    <p className="mt-5 text-sm text-ink-2">To update an address, room counts, or a service plan, <a href="tel:+14692800397" className="underline">call the office</a>.</p>
  </>;
}
