import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { Avatar } from "@/components/cleaner-card";
import { Pill } from "@/components/ui";
import {
  displayName,
  firstName,
  languageLabel,
  ratingDisplay,
  specialtyLabel,
  tenureLabel,
} from "@/lib/cleaners/profile";
import { formatDateInZone } from "@/lib/time/zone";

/** A published profile with a visit-specific preference request. */
export const dynamic = "force-dynamic";

export default async function CleanerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (isDemoMode()) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const db = await createClient();
  const directory = new CleanerDirectory(db);

  const cleaner = await directory.get(id);
  if (!cleaner) notFound();

  const reviews = await directory.reviewsFor(id);
  const rating = ratingDisplay(cleaner.rating, cleaner.ratingCount);
  const name = firstName(cleaner.fullName);

  return (
    <>
      <div className="card p-5 text-center">
        <div className="flex justify-center">
          <Avatar cleaner={cleaner} size="lg" />
        </div>

        <h1 className="mt-3 text-xl font-semibold tracking-tight text-navy">
          {displayName(cleaner.fullName)}
        </h1>

        {cleaner.backgroundCheckCleared ? (
          <p className="mt-1.5">
            <Pill tone="good">Background-checked &amp; vetted</Pill>
          </p>
        ) : null}

        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4">
          <Figure
            label="Rating"
            value={rating.show ? (rating.rating?.toFixed(1) ?? "—") : "—"}
            note={rating.show ? undefined : rating.label}
          />
          <Figure label="Cleans" value={String(cleaner.completedCleans)} />
          <Figure label="With us" value={tenureLabel(cleaner.hiredOn)} />
        </dl>
      </div>

      <section className="card mt-4 p-5"><h2 className="font-semibold text-navy">Prefer {name} for your next visit?</h2><p className="mt-2 text-sm text-ink-2">Choose your visit and send a preference to the office. Availability and acceptance still need confirmation.</p><Link href={`/customer/cleaners/${id}/request`} className="primary-action mt-4 inline-flex">Request {name}</Link></section>

      {cleaner.bio ? (
        <section className="card mt-4 p-5">
          <p className="eyebrow">About {name}</p>
          <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-ink">
            {cleaner.bio}
          </p>
        </section>
      ) : null}

      {cleaner.specialties.length > 0 || cleaner.languages.length > 0 ? (
        <section className="card mt-4 p-5">
          <p className="eyebrow">Specialties</p>
          <p className="mt-2 flex flex-wrap gap-1.5">
            {cleaner.specialties.map((key) => (
              <Pill key={key}>{specialtyLabel(key)}</Pill>
            ))}
            {cleaner.languages.map((code) => (
              <Pill key={code} tone="sky">
                {languageLabel(code)}
              </Pill>
            ))}
          </p>
        </section>
      ) : null}

      <section className="card mt-4 p-5">
        <p className="eyebrow">
          Recent reviews{cleaner.ratingCount > 0 ? ` · ${cleaner.ratingCount}` : ""}
        </p>

        {reviews.length === 0 ? (
          <p className="mt-2 text-sm text-ink-3">
            No written reviews yet. {name} is rated after every clean.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {reviews.map((review, i) => (
              <li key={i} className="border-t border-line pt-3 first:border-0 first:pt-0">
                <p className="text-xs text-ink-3">
                  <span aria-hidden className="text-navy">
                    {"★".repeat(Math.round(review.score))}
                  </span>{" "}
                  {review.reviewerName} · {formatDateInZone(review.createdAt)}
                </p>
                <p className="mt-1 text-sm text-ink">{review.comment}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="nums mt-0.5 text-lg font-semibold text-navy">{value}</dd>
      {note ? <p className="text-[10px] leading-tight text-ink-3">{note}</p> : null}
    </div>
  );
}
