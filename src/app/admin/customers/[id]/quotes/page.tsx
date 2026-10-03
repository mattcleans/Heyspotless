import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { QuoteCard } from "@/components/quotes/quote-card";
import { PrepareQuote } from "@/components/quotes/prepare-quote";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { readClientQuotes } from "@/lib/quotes/store";
import { toLocalInputValue } from "@/lib/time/zone";
import { VisitRefresh } from "@/components/visit-refresh";
export const metadata = { title: "Client quotes | Hey Spotless" };
export default async function QuotesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    repo = await getRepository(),
    customer = await repo.getCustomer(id);
  if (!customer) notFound();
  const homes = (await repo.listProperties(id)).map((p) => ({
    id: p.id,
    street: p.street,
    city: p.city,
    rooms: p.rooms,
  }));
  let quotes: Awaited<ReturnType<typeof readClientQuotes>> = [],
    error = "";
  if (!repo.isDemo) {
    try {
      quotes = await readClientQuotes(await createClient(), id);
    } catch {
      error =
        "Quotes are unavailable. Refresh before preparing or booking a quote.";
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="Office"
        title={`Quotes for ${customer.firstName} ${customer.lastName}`}
      >
        Publish exact terms in the client account. Their approval is required
        before booking.
      </PageHeader>
      <Link
        className="secondary-action inline-flex"
        href={`/admin/customers/${id}`}
      >
        Back to client
      </Link>
      <VisitRefresh label="Refresh quotes" />
      {error ? (
        <p role="alert" className="mt-4 text-sm">
          {error}
        </p>
      ) : (
        <PrepareQuote
          savedIds={quotes.map((q) => q.id)}
          homes={homes}
          demo={repo.isDemo}
          defaultExpiry={toLocalInputValue(
            new Date(new Date().getTime() + 7 * 86400000),
          )}
        />
      )}
      <section className="mt-10" aria-label="Saved quotes">
        <h2 className="text-xl font-semibold text-navy">Saved quotes</h2>
        {!error && !quotes.length && (
          <p className="mt-3 text-sm">No saved quotes for this client.</p>
        )}
        {quotes.map((q) => (
          <QuoteCard
            key={`${q.id}-${q.version}-${q.state}`}
            quote={q}
            role="admin"
          />
        ))}
      </section>
    </>
  );
}
