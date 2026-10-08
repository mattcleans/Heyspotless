import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { SERVICE_TYPES } from "@/lib/pricing/price-book";
import { myBookingReviews } from "@/lib/booking/store";
import { BookingForm } from "./booking-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Request a clean | Hey Spotless" };
export default async function Page({ searchParams }: { searchParams: Promise<{ service?: string; home?: string }> }) {
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  const customer = repo.isDemo ? await repo.getCustomerByProfile("demo")
    : profile?.role === "customer" ? await repo.getCustomerByProfile(profile.id) : null;
  if (!customer && profile?.role === "customer") return <section className="visit-feature"><h1 className="welcome-title">Add your home to get started</h1><Link href="/customer/account/homes/new" className="primary-action mt-5 inline-flex">Add your home</Link></section>;
  if (!customer) return <section className="visit-feature">
    <h1 className="welcome-title">Use your Client account</h1>
    <p className="mt-3 text-sm text-ink-2">Sign in to request a clean for your saved home. If your home is missing, call the office to connect it.</p>
    <Link href="/login?next=%2Fcustomer%2Fbook" className="primary-action mt-5 inline-flex">Sign in</Link>
  </section>;
  const homes = (await repo.listProperties(customer.id)).map(({ id, street, city, state, zip, rooms }) => ({ id, street, city, state, zip, rooms }));
  const query = await searchParams;
  const service = SERVICE_TYPES.find(s => s === query.service) ?? "standard";
  const reviews = repo.isDemo ? [] : await myBookingReviews(await createClient());
  return <>
    <h1 className="welcome-title">Your next fresh start.</h1>
    <p className="mt-3 text-sm text-ink-2">Use your saved home, choose your clean and review the exact price. We’ll confirm the Cleaner after matching.</p>
    <BookingForm homes={homes} initialService={service} initialHome={query.home} reviews={reviews} demo={repo.isDemo} />
    <div className="mt-6 flex flex-wrap gap-3">
      <Link href="/customer/schedules" className="secondary-action">Manage existing recurring schedules</Link>
      <Link href="/customer/account/homes/new" className="secondary-action">Add a home</Link>
    </div>
  </>;
}
