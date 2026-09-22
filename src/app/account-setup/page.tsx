import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";
export default async function AccountSetupPage() {
  if (isDemoMode()) redirect("/login");
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  return (
    <main className="mx-auto max-w-lg px-5 py-12">
      <Link href="/" className="brand-lockup">
        Hey Spotless
      </Link>
      <section className="visit-feature mt-8">
        <h1 className="text-2xl font-semibold text-navy">
          You’re signed in. Let’s connect your account.
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-2">
          Your login isn’t linked to a customer or cleaner workspace yet. The
          Hey Spotless team needs to finish that connection before your visits
          can appear.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          If you’re testing as an owner, your account also needs the management
          role. Signing in by itself does not grant management access.
        </p>
        <a href="tel:+14692800397" className="primary-action mt-5">
          Call Hey Spotless
        </a>
        <Link href="/auth/continue" className="secondary-action mt-3 w-full">
          Check my access again
        </Link>
      </section>
      <p className="mt-5 text-sm text-ink-2">
        New customer?{" "}
        <Link href="/book" className="underline">
          Request your first clean.
        </Link>
      </p>
    </main>
  );
}
