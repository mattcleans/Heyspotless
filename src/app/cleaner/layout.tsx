import Link from "next/link";
import type { ReactNode } from "react";
import { AppIcon } from "@/components/app-navigation";
import { isDemoMode } from "@/lib/supabase/env";

export default function CleanerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="service-app">
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
      {isDemoMode() && (
        <div className="preview-note">
          Preview only. Offers and visits use sample data.
        </div>
      )}
      <main id="cleaner-content" className="service-content">
        {children}
      </main>
      <nav className="app-tabs" aria-label="Cleaner navigation">
        <ul>
          <li>
            <Link href="/cleaner">
              <AppIcon name="calendar" />
              My day
            </Link>
          </li>
          <li>
            <a href="/cleaner#offers">
              <AppIcon name="sparkle" />
              Job offers
            </a>
          </li>
          <li>
            <a href="tel:+14692800397">
              <AppIcon name="message" />
              Get help
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}
