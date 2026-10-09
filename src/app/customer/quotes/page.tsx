import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { QuoteCard } from "@/components/quotes/quote-card";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { readClientQuotes } from "@/lib/quotes/store";
import { VisitRefresh } from "@/components/visit-refresh";
export const metadata = { title: "Your quotes | Hey Spotless" };
export default async function QuotesPage() {
  const repo = await getRepository();
  let quotes: Awaited<ReturnType<typeof readClientQuotes>> = [],
    error = "";
  if (!repo.isDemo) {
    try {
      quotes = await readClientQuotes(await createClient());
    } catch {
      error =
        "Quotes are unavailable. Refresh or call the office at 469-280-0397.";
    }
  }
  return (
    <>
      <PageHeader eyebrow="Customer" title="Your quotes">
        Review your price, extras and proposed appointment before accepting. The
        office books the visit after your approval.
      </PageHeader>
      <VisitRefresh label="Refresh quotes" />
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : quotes.length ? (
        quotes.map((q) => (
          <QuoteCard
            key={`${q.id}-${q.version}-${q.state}`}
            quote={q}
            role="customer"
          />
        ))
      ) : (
        <div className="visit-feature mt-5">
          <h2 className="font-semibold">No quotes to review</h2>
          <p className="mt-2 text-sm">
            {repo.isDemo
              ? "Sample workspace. Sign in to review a real quote."
              : "The office will publish your quote here after reviewing your home."}
          </p>
          <Link href="/book" className="secondary-action mt-4 inline-flex">
            Request a clean
          </Link>
        </div>
      )}
    </>
  );
}
