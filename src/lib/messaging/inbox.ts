import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { groupThreads, type InboxMessage, type Thread } from "./threads";

/**
 * One read for the whole inbox.
 *
 * Read as the signed-in admin rather than through the service role: row-level
 * security already says an admin sees every message, and using the request's
 * own client means the page cannot accidentally become a way for somebody else
 * to read the customer book.
 *
 * Bounded at a few hundred messages rather than paginated. That is a deliberate
 * limit for a two-person office and the wrong one for a ten-person one — when
 * the oldest thread on the page is a week old rather than a month, this needs a
 * cursor.
 */
const WINDOW = 400;

export async function loadInbox(db: SupabaseClient, limit = WINDOW): Promise<Thread[]> {
  const { data, error } = await db
    .from("messages")
    .select(
      "id, direction, body, sent_at, read_at, kind, from_address, to_address, " +
        "customer_id, cleaner_id, lead_id, " +
        "customers ( first_name, last_name ), " +
        "cleaners ( full_name ), " +
        "leads ( first_name, last_name )",
    )
    .order("sent_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`loadInbox: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];

  const messages: InboxMessage[] = rows.map((row) => {
    const customer = (row["customers"] ?? {}) as Record<string, unknown>;
    const cleaner = (row["cleaners"] ?? {}) as Record<string, unknown>;
    const lead = (row["leads"] ?? {}) as Record<string, unknown>;

    return {
      id: String(row["id"]),
      direction: row["direction"] === "inbound" ? "inbound" : "outbound",
      body: typeof row["body"] === "string" ? row["body"] : "",
      sentAt: new Date(String(row["sent_at"])),
      readAt: row["read_at"] ? new Date(String(row["read_at"])) : null,
      kind: typeof row["kind"] === "string" ? row["kind"] : null,
      customerId: typeof row["customer_id"] === "string" ? row["customer_id"] : null,
      cleanerId: typeof row["cleaner_id"] === "string" ? row["cleaner_id"] : null,
      leadId: typeof row["lead_id"] === "string" ? row["lead_id"] : null,
      fromAddress: typeof row["from_address"] === "string" ? row["from_address"] : null,
      toAddress: typeof row["to_address"] === "string" ? row["to_address"] : null,
      customerName: fullName(customer["first_name"], customer["last_name"]),
      cleanerName: typeof cleaner["full_name"] === "string" ? cleaner["full_name"] : null,
      leadName: fullName(lead["first_name"], lead["last_name"]),
    };
  });

  return groupThreads(messages);
}

function fullName(first: unknown, last: unknown): string | null {
  const parts = [first, last].filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}
