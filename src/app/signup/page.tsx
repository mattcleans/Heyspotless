import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { SignupForm } from "./signup-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Create your Client account | Hey Spotless" };
export default async function SignupPage() {
  const demo = isDemoMode();
  if (!demo) {
    const db = await createClient();
    const { data: { user } } = await db.auth.getUser();
    if (user) redirect("/auth/continue?next=%2Fcustomer%2Faccount%2Fhomes%2Fnew");
  }
  return <main className="mx-auto min-h-screen max-w-md px-5 py-12">
    <Link href="/" className="brand-lockup">Hey Spotless</Link>
    <h1 className="welcome-title mt-10">Create your Client account.</h1>
    <p className="mt-3 mb-6 text-sm text-ink-2">Use an email and password to manage your home and cleans. After confirming your email, add your home and choose your first clean.</p>
    <SignupForm demo={demo} />
    <p className="mt-6 text-sm text-ink-2">Already have an account? <Link href="/login?next=%2Fcustomer%2Fbook" className="underline">Sign in</Link>.</p>
    <p className="mt-3 text-sm text-ink-2">Cleaner or Management access? <a href="tel:+14692800397" className="underline">Contact the office</a>.</p>
  </main>;
}
