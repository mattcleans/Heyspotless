import Link from "next/link";
import { AppIcon } from "@/components/app-navigation";
import { isDemoMode } from "@/lib/supabase/env";

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12 sm:py-20">
      <Link href="/" className="brand-lockup">
        <span className="brand-mark">
          <AppIcon name="sparkle" />
        </span>
        Hey Spotless
      </Link>
      <h1 className="mt-12 max-w-xl text-4xl font-semibold leading-tight tracking-tight text-navy sm:text-5xl">
        Good care starts with good connections.
      </h1>
      <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-2">
        A welcoming home for customers. A clear day for cleaners. A helping hand
        for the people who keep it all running.
      </p>
      {isDemoMode() && (
        <p className="preview-note mt-6 rounded-lg">
          You’re exploring a preview. Sample data only, with no live bookings or
          charges.
        </p>
      )}
      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {[
          {
            href: "/customer",
            title: "Your home",
            body: "Plan a clean, follow your visit, and keep your home feeling its best.",
            action: "Open customer app",
          },
          {
            href: "/cleaner",
            title: "Your workday",
            body: "See your visits, review job offers, and find what each home needs.",
            action: "Open cleaner app",
          },
          {
            href: "/admin",
            title: "Your business",
            body: "See what needs attention, support your team, and care for your customers.",
            action: "Open management",
          },
        ].map((item) => (
          <section key={item.href} className="card flex flex-col p-6">
            <h2 className="text-xl font-semibold text-navy">{item.title}</h2>
            <p className="mt-3 mb-6 flex-1 text-sm leading-relaxed text-ink-2">
              {item.body}
            </p>
            <Link className="secondary-action" href={item.href}>
              {item.action}
            </Link>
          </section>
        ))}
      </div>
      <p className="mt-8 text-sm text-ink-2">
        New here?{" "}
        <Link
          href="/book"
          className="font-semibold text-navy underline underline-offset-4"
        >
          Get an estimate for your clean.
        </Link>
      </p>
    </div>
  );
}
