import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { signPhotoUrls } from "./photo";

/**
 * Reading a cleaner as a customer sees her.
 *
 * Every read here goes through `cleaner_profiles`, never `cleaners`. The base
 * table carries her pay terms, her insurance expiry and her profile id, and
 * there is no column-level row security to lean on — so the safe columns were
 * enumerated once in `0028` and this is the only door.
 */

export interface CleanerProfile {
  id: string;
  fullName: string;
  bio: string | null;
  photoPath: string | null;
  /** The signed address of `photoPath`, filled in by the reads below. */
  photoUrl: string | null;
  specialties: string[];
  languages: string[];
  hiredOn: Date | null;
  serviceZips: string[];
  rating: number | null;
  ratingCount: number;
  completedCleans: number;
  backgroundCheckCleared: boolean;
}

export interface CleanerReview {
  score: number;
  comment: string;
  createdAt: Date;
  reviewerName: string;
}

export class CleanerDirectory {
  constructor(private readonly db: SupabaseClient) {}

  async get(id: string): Promise<CleanerProfile | null> {
    const { data, error } = await this.db
      .from("cleaner_profiles")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(`cleaner_profiles: ${error.message}`);
    if (!data) return null;

    const [profile] = await this.withPhotos([toProfile(data as Record<string, unknown>)]);
    return profile ?? null;
  }

  /**
   * Who serves this postcode.
   *
   * NOT A PICK LIST. The engine decides who cleans a given house — see `0028`
   * and the dispatch rules it points at. This is the answer to "who are these
   * people", which a customer is entitled to ask before letting one of them in,
   * and it carries no rates and no book button for exactly that reason.
   *
   * A cleaner with no declared zips serves everywhere, which is the same
   * reading the eligibility gate in `0003` takes.
   */
  async servingZip(zip: string | null, limit = 12): Promise<CleanerProfile[]> {
    const { data, error } = await this.db
      .from("cleaner_profiles")
      .select("*")
      .order("completed_cleans", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`cleaner_profiles: ${error.message}`);

    const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
    const profiles = rows.map(toProfile);

    const matching = zip
      ? profiles.filter((c) => c.serviceZips.length === 0 || c.serviceZips.includes(zip))
      : profiles;

    return this.withPhotos(matching);
  }

  /**
   * Fill in `photoUrl` for a page's worth of cleaners in one signing call.
   *
   * The bucket is private, so the path in the column is not an address. A
   * signature that fails leaves `photoUrl` null and the card falls back to her
   * initials — a missing face is not worth failing a page over.
   */
  private async withPhotos(profiles: CleanerProfile[]): Promise<CleanerProfile[]> {
    const paths = profiles.map((c) => c.photoPath).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return profiles;

    const signed = await signPhotoUrls(this.db, paths);
    return profiles.map((c) => ({
      ...c,
      photoUrl: c.photoPath ? (signed.get(c.photoPath) ?? null) : null,
    }));
  }

  /** The handful of reviews a profile shows. Newest first. */
  async reviewsFor(cleanerId: string, limit = 5): Promise<CleanerReview[]> {
    const { data, error } = await this.db
      .from("cleaner_reviews")
      .select("score, comment, created_at, reviewer_name")
      .eq("cleaner_id", cleanerId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`cleaner_reviews: ${error.message}`);

    const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      score: Number(row["score"] ?? 0),
      comment: String(row["comment"] ?? ""),
      createdAt: new Date(String(row["created_at"])),
      reviewerName: String(row["reviewer_name"] ?? "A customer"),
    }));
  }
}

function toProfile(row: Record<string, unknown>): CleanerProfile {
  return {
    id: String(row["id"]),
    fullName: typeof row["full_name"] === "string" ? row["full_name"] : "",
    bio: typeof row["bio"] === "string" ? row["bio"] : null,
    photoPath: typeof row["photo_path"] === "string" ? row["photo_path"] : null,
    photoUrl: null,
    specialties: Array.isArray(row["specialties"]) ? (row["specialties"] as string[]) : [],
    languages: Array.isArray(row["languages"]) ? (row["languages"] as string[]) : [],
    hiredOn: row["hired_on"] ? new Date(String(row["hired_on"])) : null,
    serviceZips: Array.isArray(row["service_zips"]) ? (row["service_zips"] as string[]) : [],
    rating: row["rating"] === null || row["rating"] === undefined ? null : Number(row["rating"]),
    ratingCount: Number(row["rating_count"] ?? 0),
    completedCleans: Number(row["completed_cleans"] ?? 0),
    backgroundCheckCleared: row["background_check_cleared"] === true,
  };
}
