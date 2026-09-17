import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlannedAutomation } from "./plan";

/**
 * The automation queue, and the context an action needs to say anything.
 *
 * Service-role: the sweep runs with no signed-in user, like every other sweep
 * in this system.
 */

export interface DueAutomation {
  id: string;
  triggerKey: string;
  actionKey: string;
  subjectType: string;
  subjectId: string;
  scheduledFor: Date | null;
  attempts: number;
}

/**
 * Everything a customer message needs, in one read.
 *
 * Gathered here rather than through the repository because the sweep needs a
 * handful of fields across five tables for up to fifty jobs, and doing that a
 * job at a time through the domain mapper is fifty round trips to save an
 * interface.
 */
export interface JobContact {
  jobId: string;
  status: string;
  service: string;
  scheduledStart: Date | null;
  customerId: string;
  customerFirstName: string;
  customerPhone: string | null;
  customerOptedOut: boolean;
  street: string;
  cleanerId: string | null;
  cleanerFirstName: string | null;
}

/** What a nudge needs, and every reason not to send one. */
export interface LeadContact {
  leadId: string;
  firstName: string;
  phone: string | null;
  status: string;
  firstResponseAt: Date | null;
  smsConsentAt: Date | null;
  quotedPriceCents: number | null;
}

export class AutomationStore {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Put a planned action on the queue, or move it if it is already there and
   * has not fired.
   *
   * Returns what happened, because the sweep's response is the only thing
   * anybody reads: "scheduled 3, moved 1" is a working planner, and "moved 40"
   * every hour is a planner fighting something else for the same rows.
   */
  async schedule(planned: PlannedAutomation): Promise<"scheduled" | "moved" | "unchanged"> {
    const { data, error } = await this.db.rpc("schedule_automation", {
      p_dedupe_key: planned.dedupeKey,
      p_trigger_key: planned.triggerKey,
      p_action_key: planned.actionKey,
      p_subject_type: planned.subjectType,
      p_subject_id: planned.subjectId,
      p_scheduled_for: planned.scheduledFor.toISOString(),
    });
    if (error) throw new Error(`schedule_automation: ${error.message}`);
    if (typeof data === "string") return "scheduled";

    // Already queued. The visit may have moved since, which is the one case
    // where an existing row is wrong rather than redundant.
    const moved = await this.db.rpc("reschedule_automation", {
      p_dedupe_key: planned.dedupeKey,
      p_scheduled_for: planned.scheduledFor.toISOString(),
    });
    if (moved.error) throw new Error(`reschedule_automation: ${moved.error.message}`);
    return moved.data === true ? "moved" : "unchanged";
  }

  /** Take a batch of due work under a lease nobody else can hold. */
  async claimDue(owner: string, limit: number): Promise<DueAutomation[]> {
    const { data, error } = await this.db.rpc("claim_due_automations", {
      p_owner: owner,
      p_limit: limit,
    });
    if (error) throw new Error(`claim_due_automations: ${error.message}`);

    return (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
      id: String(row["id"]),
      triggerKey: String(row["trigger_key"]),
      actionKey: String(row["action_key"]),
      subjectType: String(row["subject_type"]),
      subjectId: String(row["subject_id"]),
      scheduledFor: row["scheduled_for"] ? new Date(String(row["scheduled_for"])) : null,
      attempts: Number(row["attempts"] ?? 0),
    }));
  }

  /**
   * What the action did. `failed` releases the lease rather than marking it
   * fired, so the next sweep tries again.
   */
  async settle(
    id: string,
    owner: string,
    outcome: "sent" | "skipped" | "failed",
    error: string | null = null,
    messageId: string | null = null,
  ): Promise<void> {
    const { error: rpcError } = await this.db.rpc("settle_automation", {
      p_id: id,
      p_owner: owner,
      p_outcome: outcome,
      p_error: error,
      p_message_id: messageId,
    });
    if (rpcError) throw new Error(`settle_automation: ${rpcError.message}`);
  }

  /**
   * The jobs worth planning against: scheduled in the window, plus anything
   * recently completed that has not been asked about yet.
   */
  async jobsToPlan(from: Date, to: Date): Promise<
    {
      id: string;
      status: string;
      createdAt: Date;
      scheduledStart: Date | null;
      completedAt: Date | null;
    }[]
  > {
    const { data, error } = await this.db
      .from("jobs")
      .select("id, status, created_at, scheduled_start, completed_at")
      .or(
        `and(scheduled_start.gte.${from.toISOString()},scheduled_start.lte.${to.toISOString()}),` +
          `completed_at.gte.${from.toISOString()}`,
      )
      .limit(2000);
    if (error) throw new Error(`jobsToPlan: ${error.message}`);

    return (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
      id: String(row["id"]),
      status: String(row["status"]),
      createdAt: new Date(String(row["created_at"])),
      scheduledStart: row["scheduled_start"] ? new Date(String(row["scheduled_start"])) : null,
      completedAt: row["completed_at"] ? new Date(String(row["completed_at"])) : null,
    }));
  }

  /**
   * Leads still worth chasing.
   *
   * Bounded by age rather than by count: a lead older than the whole sequence
   * has nothing left to plan, and scanning the entire history every hour to
   * discover that is a query that gets slower every month the business runs.
   */
  async leadsToPlan(since: Date): Promise<
    {
      id: string;
      status: string;
      receivedAt: Date;
      firstResponseAt: Date | null;
      smsConsentAt: Date | null;
      phone: string | null;
    }[]
  > {
    const { data, error } = await this.db
      .from("leads")
      .select("id, status, received_at, first_response_at, sms_consent_at, phone")
      .in("status", ["new", "quoted"])
      .gte("received_at", since.toISOString())
      .limit(1000);
    if (error) throw new Error(`leadsToPlan: ${error.message}`);

    return (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
      id: String(row["id"]),
      status: String(row["status"]),
      receivedAt: new Date(String(row["received_at"])),
      firstResponseAt: row["first_response_at"] ? new Date(String(row["first_response_at"])) : null,
      smsConsentAt: row["sms_consent_at"] ? new Date(String(row["sms_consent_at"])) : null,
      phone: typeof row["phone"] === "string" ? row["phone"] : null,
    }));
  }

  /** Who to chase, and what they were quoted. */
  async leadContactsFor(leadIds: readonly string[]): Promise<Map<string, LeadContact>> {
    const byLead = new Map<string, LeadContact>();
    if (leadIds.length === 0) return byLead;

    const { data, error } = await this.db
      .from("leads")
      .select("id, first_name, phone, status, first_response_at, sms_consent_at, quoted_price_cents")
      .in("id", [...leadIds]);
    if (error) throw new Error(`leadContactsFor: ${error.message}`);

    for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
      const id = row["id"];
      if (typeof id !== "string") continue;

      byLead.set(id, {
        leadId: id,
        firstName:
          typeof row["first_name"] === "string" && row["first_name"] ? row["first_name"] : "there",
        phone: typeof row["phone"] === "string" ? row["phone"] : null,
        status: String(row["status"]),
        firstResponseAt: row["first_response_at"]
          ? new Date(String(row["first_response_at"]))
          : null,
        smsConsentAt: row["sms_consent_at"] ? new Date(String(row["sms_consent_at"])) : null,
        quotedPriceCents:
          typeof row["quoted_price_cents"] === "number" ? row["quoted_price_cents"] : null,
      });
    }
    return byLead;
  }

  /** Who to tell, and what about, for a set of jobs. */
  async contactsFor(jobIds: readonly string[]): Promise<Map<string, JobContact>> {
    const byJob = new Map<string, JobContact>();
    if (jobIds.length === 0) return byJob;

    const { data, error } = await this.db
      .from("jobs")
      .select(
        "id, status, service, scheduled_start, customer_id, " +
          "customers ( id, first_name, phone, sms_opted_out_at ), " +
          "properties ( street ), " +
          "job_assignments ( cleaner_id, is_lead, cleaners ( full_name ) )",
      )
      .in("id", [...jobIds]);
    if (error) throw new Error(`contactsFor: ${error.message}`);

    // Through `unknown` because the select nests two levels
    // (job_assignments → cleaners), which is past the point where the client's
    // generated row type is a useful description of what comes back.
    const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];

    for (const row of rows) {
      const id = row["id"];
      if (typeof id !== "string") continue;

      const customer = (row["customers"] ?? {}) as Record<string, unknown>;
      const property = (row["properties"] ?? {}) as Record<string, unknown>;

      // The lead cleaner, or the only one. A second cleaner on a job does not
      // change who the customer is expecting at the door.
      const assignments = (Array.isArray(row["job_assignments"]) ? row["job_assignments"] : []) as
        Record<string, unknown>[];
      const lead = assignments.find((a) => a["is_lead"] === true) ?? assignments[0];
      const cleaner = (lead?.["cleaners"] ?? {}) as Record<string, unknown>;
      const cleanerName = typeof cleaner["full_name"] === "string" ? cleaner["full_name"] : null;

      byJob.set(id, {
        jobId: id,
        status: String(row["status"]),
        service: typeof row["service"] === "string" ? row["service"] : "clean",
        scheduledStart: row["scheduled_start"] ? new Date(String(row["scheduled_start"])) : null,
        customerId: String(row["customer_id"]),
        // First name only, for the reason the cleaner messages give: a text
        // that opens with a full legal name reads like a debt collector.
        customerFirstName:
          typeof customer["first_name"] === "string" && customer["first_name"]
            ? customer["first_name"]
            : "there",
        customerPhone: typeof customer["phone"] === "string" ? customer["phone"] : null,
        customerOptedOut: customer["sms_opted_out_at"] != null,
        street: typeof property["street"] === "string" ? property["street"] : "",
        cleanerId: typeof lead?.["cleaner_id"] === "string" ? lead["cleaner_id"] : null,
        cleanerFirstName: cleanerName ? (cleanerName.split(" ")[0] ?? null) : null,
      });
    }
    return byJob;
  }
}
