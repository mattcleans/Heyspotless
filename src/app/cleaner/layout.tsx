import { WorkspaceIdentity } from "@/components/workspace-identity";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppNavigation, AppIcon } from "@/components/app-navigation";
import { isDemoMode } from "@/lib/supabase/env";

export default function CleanerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="service-app workspace-app">
      <a href="#cleaner-content" className="skip-link">
        Skip to content
      </a>
      <header className="service-header">
        <Link href="/cleaner" className="brand-lockup">
          <span className="brand-mark">
            <AppIcon name="sparkle" />
          </span>
          Hey Spotless
        </Link>
        <a href="tel:+14692800397" className="help-link">
          Call the office
        </a>
      </header>
      <WorkspaceIdentity area="cleaner" />
      {isDemoMode() && (
        <div className="preview-note">
          Preview only. Offers and visits use sample data.
        </div>
      )}
      <main id="cleaner-content" className="service-content">
        {children}
      </main>
      <AppNavigation label="Cleaner navigation" tabs={[
        { href: "/cleaner", label: "My day", icon: "home" },
        { href: "/cleaner/schedule", label: "Schedule", icon: "calendar" },
        { href: "/cleaner#offers", label: "Job offers", icon: "sparkle" },
        { href: "/cleaner/earnings", label: "Pay", icon: "account" },
        { href: "/cleaner/availability", label: "Hours", icon: "account" },
      ]} />
    </div>
  );
}
