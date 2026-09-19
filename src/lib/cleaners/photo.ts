import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Turning a stored photo path into something an <img> can load.
 *
 * WHY THIS IS NOT JUST A URL IN THE COLUMN. `cleaners.photo_path` holds a
 * storage path because the bucket may move and a column full of absolute URLs
 * is a migration nobody can run. And the bucket is private — a cleaner's face
 * is shown to the customer whose house she is cleaning, not published to the
 * open internet — so the address has to be signed and has to expire.
 *
 * SIGNED IN BULK. A directory page shows a dozen cleaners, and a signature
 * round trip each is a dozen sequential requests to render one list. One call
 * covers the page.
 */

export const CLEANER_PHOTO_BUCKET = "cleaner-photos";

/**
 * How long a signed photo URL lives.
 *
 * An hour: long enough that a page left open over lunch still shows her face,
 * short enough that a URL pasted somewhere stops working. These pages are
 * rendered per request anyway, so nothing here is cached beyond it.
 */
export const PHOTO_URL_TTL_SECONDS = 3600;

/** Where a cleaner's photo goes. The second segment is whose it is — 0028's policies read it. */
export function cleanerPhotoPath(cleanerId: string, extension: string): string {
  return `cleaners/${cleanerId}/headshot.${extension.replace(/^\./, "").toLowerCase()}`;
}

/**
 * Sign a set of paths at once. Missing or unsignable paths come back absent
 * rather than throwing: a broken photo is initials, never a blank page.
 */
export async function signPhotoUrls(
  db: SupabaseClient,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(paths.filter((p) => p.length > 0))];
  const signed = new Map<string, string>();
  if (wanted.length === 0) return signed;

  const { data, error } = await db.storage
    .from(CLEANER_PHOTO_BUCKET)
    .createSignedUrls(wanted, PHOTO_URL_TTL_SECONDS);

  if (error || !Array.isArray(data)) return signed;

  for (const row of data) {
    if (row.path && row.signedUrl && !row.error) signed.set(row.path, row.signedUrl);
  }
  return signed;
}
