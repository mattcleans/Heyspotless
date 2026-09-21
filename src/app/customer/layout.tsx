import Link from "next/link";
import type { ReactNode } from "react";
import { CUSTOMER_BRAND } from "@/lib/brand";
import { AppNavigation, AppIcon } from "@/components/app-navigation";
import { isDemoMode } from "@/lib/supabase/env";

export default function ClientAppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="service-app">
      <a href="#customer-content" className="skip-link">
        Skip to content
      </a>
      <header className="service-header">
        <Link href="/customer" className="brand-lockup">
          <span className="brand-mark">
            <AppIcon name="sparkle" />
          </span>
          {CUSTOMER_BRAND}
        </Link>
        <a href="tel:+14692800397" className="help-link">
          Get help
        </a>
      </header>
      {isDemoMode() && (
        <div className="preview-note">
          Preview only. No live bookings or charges.
        </div>
      )}
      <main id="customer-content" className="service-content">
        {children}
      </main>
      <AppNavigation
        label="Customer navigation"
        tabs={[
          { href: "/customer", label: "Home", icon: "home" },
          { href: "/customer/cleaners", label: "Cleaners", icon: "people" },
          { href: "/customer/visits", label: "Visits", icon: "calendar" },
          { href: "/customer/account", label: "Account", icon: "account" },
        ]}
      />
    </div>
  );
}
