import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { safeNext } from "@/lib/auth/navigation";
import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Password settings | Hey Spotless" };

export default async function PasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  let next = safeNext(params.next);
  if (new URL(next, "https://local.invalid").pathname === "/account/password")
    next = "/";
  if (isDemoMode())
    return (
      <main className="mx-auto min-h-screen max-w-md px-5 py-12">
        <Link href="/" className="brand-lockup">
          Hey Spotless
        </Link>
        <h1 className="welcome-title mt-10">Password settings</h1>
        <p className="mt-4 text-sm text-ink-2">
          Password settings are available when you sign in to your real account.
        </p>
        <Link href="/login" className="secondary-action mt-6">
          Back to sign-in
        </Link>
      </main>
    );
  let user;
  try {
    const db = await createClient();
    const result = await db.auth.getUser();
    if (!result.error) user = result.data.user;
  } catch {
    redirect("/login?error=service_unavailable");
  }
  if (!user)
    redirect(
      `/login?next=${encodeURIComponent(`/account/password?next=${encodeURIComponent(next)}`)}`,
    );
  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-12">
      <Link href="/" className="brand-lockup">
        Hey Spotless
      </Link>
      <h1 className="welcome-title mt-10">Choose your password.</h1>
      <p className="mt-3 mb-6 break-words text-sm text-ink-2">
        Set or change the password for <strong>{user.email}</strong>. Use it
        with your email for your next sign-in.
      </p>
      <PasswordForm ownerId={user.id} next={next} />
    </main>
  );
}
