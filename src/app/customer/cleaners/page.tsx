import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { getRepository } from "@/lib/data";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { CleanerCard } from "@/components/cleaner-card";
import { Callout } from "@/components/ui";

/**
 * Screen 2 — the people who clean here.
 *
 * THE DESIGN CALLED THIS "CLEANERS NEAR YOU" AND GAVE EACH ONE A RATE AND A
 * BOOK BUTTON. That is a marketplace, and it is not this business: the
 * dispatch engine decides who cleans a given house, spending guaranteed hours
 * before buying any, holding a home for the cleaner who already knows it, and
 * never paying more than its own cheapest option. A customer picking from a
 * list bypasses all of it, and a rate on a card makes the cleaner a
 * price-setter.
 *
 * So the screen answers the question the design was really reaching for —
 * "who are these people, and should I let one into my house?" — and leaves the
 * matching where it belongs. No rates, no book buttons, no choosing.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Your cleaners" };

export default async function CleanersPage() {
  if (isDemoMode()) {
    return (
      <>
        <h1 className="text-xl font-semibold tracking-tight text-navy">Your cleaners</h1>
        <div className="card mt-4 p-6 text-center text-sm text-ink-3">
          Cleaner profiles need a live database.
        </div>
      </>
    );
  }

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const customer = profile ? await repo.getCustomerByProfile(profile.id) : null;

  const db = await createClient();
  const directory = new CleanerDirectory(db);

  // The home we are matching against, for "who serves your area".
  const properties = customer ? await repo.listProperties(customer.id) : [];
  const zip = properties[0]?.zip ?? null;

  /**
   * Whoever has already cleaned this home.
   *
   * Read from the job's continuity rather than by scanning assignments: the
   * incumbent is precisely "the cleaner this property keeps getting", which is
   * the same thing the engine holds the home for before anybody else sees it.
   * A preferred cleaner — one the customer asked for — comes first where there
   * is one.
   */
  const jobs = customer ? await repo.listJobs({ customerId: customer.id, limit: 25 }) : [];
  const yourCleanerIds = [
    ...new Set(
      jobs
        .flatMap((j) => [j.continuity?.preferredCleanerId, j.continuity?.incumbentCleanerId])
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const [yours, team] = await Promise.all([
    Promise.all(yourCleanerIds.slice(0, 3).map((id) => directory.get(id))),
    directory.servingZip(zip),
  ]);

  const mine = yours.filter((c): c is NonNullable<typeof c> => c !== null);
  const mineIds = new Set(mine.map((c) => c.id));
  const others = team.filter((c) => !mineIds.has(c.id));

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-navy">Your cleaners</h1>
      <p className="mt-1 mb-4 text-sm text-ink-2">
        Every cleaner is background-checked and insured before their first visit.
      </p>

      {mine.length > 0 ? (
        <section className="mb-6 space-y-2">
          {mine.map((cleaner, i) => (
            <CleanerCard
              key={cleaner.id}
              cleaner={cleaner}
              href={`/customer/cleaners/${cleaner.id}`}
              label={i === 0 ? "Your usual cleaner" : "Has cleaned for you"}
            />
          ))}
          <p className="px-1 text-xs text-ink-3">
            We keep sending the same cleaner back. You will only see somebody new if she is
            unavailable, or if you ask.
          </p>
        </section>
      ) : (
        <Callout tone="good" label="How matching works">
          We match a cleaner to your home rather than asking you to choose one — and once
          somebody has cleaned for you, that home is held for her before anyone else sees it.
        </Callout>
      )}

      {others.length > 0 ? (
        <section className="mt-6">
          <p className="eyebrow mb-2">
            {zip ? `Also cleaning in ${zip}` : "Also on the team"}
          </p>
          <div className="space-y-2">
            {others.map((cleaner) => (
              <CleanerCard
                key={cleaner.id}
                cleaner={cleaner}
                href={`/customer/cleaners/${cleaner.id}`}
              />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
