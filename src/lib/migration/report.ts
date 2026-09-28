import { looksLikePhone } from "./hcp.ts";

/**
 * What the dry run says — which is the point of running it.
 *
 * Every skipped or doubtful row is grouped under its reason, with a count and
 * the first few examples, so 1,781 rows become a dozen lines a person can act
 * on. Examples carry enough to find the row in Housecall Pro (the job number)
 * and no more: names are masked, and no full phone number or email address is
 * printed, because this output gets pasted into chats and pull requests.
 */

export interface Example {
  /** `job 52`, `customer 131736465`, `plans row 3`. */
  ref: string;
  name: string;
  raw: string;
}

export const EXAMPLES_PER_REASON = 5;

export class Tally {
  private readonly entries = new Map<string, { count: number; examples: Example[] }>();

  add(reason: string, example?: Example): void {
    const entry = this.entries.get(reason) ?? { count: 0, examples: [] };
    entry.count += 1;
    if (example && entry.examples.length < EXAMPLES_PER_REASON) entry.examples.push(example);
    this.entries.set(reason, entry);
  }

  count(reason: string): number {
    return this.entries.get(reason)?.count ?? 0;
  }

  get total(): number {
    let n = 0;
    for (const entry of this.entries.values()) n += entry.count;
    return n;
  }

  /** Largest first, so the reason worth fixing is at the top. */
  list(): { reason: string; count: number; examples: Example[] }[] {
    return [...this.entries.entries()]
      .map(([reason, entry]) => ({ reason, ...entry }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  }
}

/** `Paula Martinez` → `P**** M****`. A name that is a phone number keeps its last four digits. */
export function maskName(name: string | null): string {
  if (!name || !name.trim()) return "(no name)";
  if (looksLikePhone(name)) return `phone …${name.replace(/\D/g, "").slice(-4)}`;
  return name
    .trim()
    .split(/\s+/)
    .map((word) => `${word[0]}****`)
    .join(" ");
}

/** Emails and phone numbers inside a raw value, masked; everything else as it was. */
export function maskValue(raw: string): string {
  return raw
    .replace(/([^\s@,;<>"']+)@([^\s@,;<>"']+)/g, (_, local: string, domain: string) => `${local[0]}****@${domain}`)
    .replace(/\+?\(?\d[\d\s().-]{8,}\d/g, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 10 ? `***-***-${digits.slice(-4)}` : match;
    });
}

export function formatTally(title: string, tally: Tally): string[] {
  const lines: string[] = [];
  const list = tally.list();
  if (list.length === 0) return lines;
  lines.push(`${title}:`);
  for (const { reason, count, examples } of list) {
    lines.push(`  [${count}] ${reason}`);
    for (const ex of examples) {
      lines.push(`        ${ex.ref} · ${ex.name}${ex.raw ? ` · "${maskValue(ex.raw)}"` : ""}`);
    }
  }
  return lines;
}
