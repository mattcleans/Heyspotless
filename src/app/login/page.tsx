import Link from "next/link";
import { redirect } from "next/navigation";
import { isDemoMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";
import { LOGIN_ERRORS, safeNext } from "@/lib/auth/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in | Hey Spotless" };
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const demo = isDemoMode();
  let message = params.error
    ? (LOGIN_ERRORS[params.error] ??
      "We couldn’t complete sign-in. Please try again.")
    : null;
  let signedIn = false;
  if (!demo && !params.error) {
    try {
      const db = await createClient();
      const {
        data: { user },
      } = await db.auth.getUser();
      signedIn = Boolean(user);
    } catch {
      message = LOGIN_ERRORS.service_unavailable!;
    }
  }
  if (signedIn) redirect(`/auth/continue?next=${encodeURIComponent(next)}`);
  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-12">
      <Link href="/" className="brand-lockup">
        Hey Spotless
      </Link>
      <h1 className="welcome-title mt-10">Welcome back.</h1>
      <p className="mt-3 mb-6 text-sm text-ink-2">
        Sign in with your email. No password needed.
      </p>
      {message && (
        <p
          role="alert"
          className="mb-5 rounded-xl border border-line bg-cream-soft p-4 text-sm text-ink"
        >
          {message}
        </p>
      )}
      {demo ? (
        <section className="visit-feature">
          <h2 className="font-semibold text-navy">Explore the app preview</h2>
          <p className="mt-2 text-sm text-ink-2">
            This version uses sample data, so you don’t need to sign in. Choose
            the experience you want to test.
          </p>
          <div className="mt-5 flex flex-col gap-3">
            <Link className="secondary-action" href="/customer">
              Test customer app
            </Link>
            <Link className="secondary-action" href="/cleaner">
              Test cleaner app
            </Link>
            <Link className="secondary-action" href="/admin">
              Test management
            </Link>
          </div>
        </section>
      ) : (
        <LoginForm next={next} />
      )}
      <p className="mt-6 text-sm text-ink-2">
        Need help? Call{" "}
        <a className="underline" href="tel:+14692800397">
          469-280-0397
        </a>
        .
      </p>
    </main>
  );
}
