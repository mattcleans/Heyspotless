import { PageHeader, Callout } from "@/components/ui";
import { isDemoMode } from "@/lib/supabase/env";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in — Spotless Ops" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  // Only ever redirect to a path on this site — an open redirect here would let
  // a sign-in link land somewhere else entirely.
  const raw = params.next ?? "/";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  return (
    <div className="mx-auto max-w-md">
      <PageHeader eyebrow="Spotless Ops" title="Sign in" />
      {isDemoMode() ? (
        <Callout tone="warn" label="Demo mode">
          No Supabase project is configured, so there is nothing to sign in to and every surface is
          open. Set <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to enable
          authentication. See <code className="font-mono text-xs">docs/setup.md</code>.
        </Callout>
      ) : (
        <LoginForm next={next} />
      )}
    </div>
  );
}
