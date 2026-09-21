import Link from "next/link";
import { BookingWidget } from "./booking-widget";
import { SERVICE_TYPES, type ServiceType } from "@/lib/pricing/price-book";
import { isDemoMode } from "@/lib/supabase/env";
import { AppIcon } from "@/components/app-navigation";

export const metadata = {
  title: "Build your clean | Hey Spotless",
  description: "See your estimate and request a clean for your home.",
};
export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string }>;
}) {
  const { service } = await searchParams;
  const initialService = SERVICE_TYPES.includes(service as ServiceType)
    ? (service as ServiceType)
    : "standard";
  const demo = isDemoMode();
  return (
    <div className="service-app">
      <header className="service-header">
        <Link href="/customer" className="brand-lockup">
          <span className="brand-mark">
            <AppIcon name="sparkle" />
          </span>
          Hey Spotless
        </Link>
        <a href="tel:+14692800397" className="help-link">
          Get help
        </a>
      </header>
      {demo && (
        <div className="preview-note">
          Preview only. Explore your estimate. Requests are not sent.
        </div>
      )}
      <main className="service-content">
        <h1 className="welcome-title">Build your clean.</h1>
        <p className="mt-3 mb-6 text-sm leading-relaxed text-ink-2">
          A little about your home, a clear estimate, and a helping hand. Our
          team will confirm availability and the final price before your visit.
        </p>
        <BookingWidget initialService={initialService} demo={demo} />
      </main>
    </div>
  );
}
