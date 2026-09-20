import Link from "next/link";
import { Pill } from "@/components/ui";
import {
  displayName,
  initials,
  languageLabel,
  ratingDisplay,
  specialtyLabel,
  tenureLabel,
} from "@/lib/cleaners/profile";
import type { CleanerProfile } from "@/lib/cleaners/store";

/**
 * A cleaner, as a customer meets her.
 *
 * NO RATE AND NO BOOK BUTTON. The engine matches cleaners to cleans — the
 * customer is meeting the person who is coming, not shopping a marketplace —
 * so there is nothing here to compare on price and nothing to choose between.
 * What the card carries instead is the answer to "who is this": a face, a
 * tenure, what she is good at, and what other people said.
 */
export function CleanerCard({
  cleaner,
  href,
  label,
}: {
  cleaner: CleanerProfile;
  href?: string;
  label?: string;
}) {
  const rating = ratingDisplay(cleaner.rating, cleaner.ratingCount);

  const body = (
    <>
      <div className="flex items-start gap-3">
        <Avatar cleaner={cleaner} />

        <div className="min-w-0 flex-1">
          {label ? <p className="eyebrow">{label}</p> : null}
          <p className="font-semibold text-navy">{displayName(cleaner.fullName)}</p>

          <p className="mt-0.5 text-xs text-ink-3">
            {rating.show ? (
              <>
                <span className="nums text-navy">{rating.rating?.toFixed(1)}</span> ·{" "}
                {cleaner.completedCleans} cleans
              </>
            ) : (
              rating.label
            )}
            {cleaner.hiredOn ? ` · ${tenureLabel(cleaner.hiredOn)} with us` : ""}
          </p>

          <p className="mt-1.5 flex flex-wrap gap-1">
            {cleaner.backgroundCheckCleared ? <Pill tone="good">Background-checked</Pill> : null}
            {cleaner.specialties.slice(0, 2).map((key) => (
              <Pill key={key}>{specialtyLabel(key)}</Pill>
            ))}
            {cleaner.languages.map((code) => (
              <Pill key={code} tone="sky">
                {languageLabel(code)}
              </Pill>
            ))}
          </p>
        </div>
      </div>
    </>
  );

  if (!href) return <div className="card p-4">{body}</div>;

  return (
    <Link href={href} className="card block p-4 transition-colors hover:border-sky-deep">
      {body}
    </Link>
  );
}

/**
 * Her photo, or her initials until there is one.
 *
 * Initials rather than a silhouette: a generic avatar on the person coming to
 * your house reads as an empty record, and two letters at least belong to her.
 */
export function Avatar({
  cleaner,
  size = "md",
}: {
  cleaner: Pick<CleanerProfile, "fullName" | "photoUrl">;
  size?: "md" | "lg";
}) {
  const dimension = size === "lg" ? "h-20 w-20 text-xl" : "h-12 w-12 text-sm";

  if (cleaner.photoUrl) {
    /*
     * A plain <img> rather than next/image: these are served from Supabase
     * Storage behind a signed URL that changes every hour, which the image
     * loader cannot cache or pre-size. The photos are small and already sized
     * on upload.
     */
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={cleaner.photoUrl}
        alt={displayName(cleaner.fullName)}
        className={`${dimension} shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`${dimension} flex shrink-0 items-center justify-center rounded-full bg-sky/25 font-semibold text-navy`}
    >
      {initials(cleaner.fullName)}
    </span>
  );
}
