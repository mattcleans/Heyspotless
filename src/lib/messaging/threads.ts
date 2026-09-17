/**
 * Messages, gathered into conversations.
 *
 * A THREAD IS DERIVED, NEVER STORED. There is no `threads` table and there is
 * not going to be one: a thread is "every message with this person, in order",
 * and the moment that becomes a row with its own `last_message_at` and
 * `unread_count` it is a second copy of the truth that can disagree with the
 * first. The disagreement always shows up the same way — an inbox with a badge
 * saying 3 and nothing unread in it — and it is unfixable without a repair job.
 *
 * Deriving it costs one indexed read and a group-by in memory. The inbox is
 * looked at by two people.
 *
 * Pure, so the grouping rules can be asserted without a database.
 */

export interface InboxMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt: Date;
  readAt: Date | null;
  kind: string | null;
  customerId: string | null;
  cleanerId: string | null;
  leadId: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  /** Display names, resolved by the caller's query. */
  customerName?: string | null;
  cleanerName?: string | null;
  leadName?: string | null;
}

export type ThreadParty =
  | { kind: "customer"; id: string }
  | { kind: "cleaner"; id: string }
  | { kind: "lead"; id: string }
  /** Nobody we recognise. The number is the identity until somebody says otherwise. */
  | { kind: "unknown"; id: string };

export interface Thread {
  key: string;
  party: ThreadParty;
  name: string;
  phone: string | null;
  messages: InboxMessage[];
  lastAt: Date;
  unread: number;
}

/**
 * Which conversation a message belongs to.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. A message can carry several ids at once —
 * an on-my-way text is attached to the customer, the cleaner who sent it, and
 * the job. Filing it under the cleaner would scatter the customer's own
 * conversation across two threads, which is exactly what makes an inbox
 * useless. So: whoever the message was WITH, from the office's point of view.
 * The customer comes first, the lead next (a lead is a customer who has not
 * bought yet), and the cleaner last.
 */
export function partyOf(message: InboxMessage): ThreadParty {
  if (message.customerId) return { kind: "customer", id: message.customerId };
  if (message.leadId) return { kind: "lead", id: message.leadId };
  if (message.cleanerId) return { kind: "cleaner", id: message.cleanerId };

  // Unattached: a text from a number in nobody's record. Still a conversation,
  // and the one most likely to be a new customer.
  const number = message.direction === "inbound" ? message.fromAddress : message.toAddress;
  return { kind: "unknown", id: number ?? "unattached" };
}

export function threadKey(party: ThreadParty): string {
  return `${party.kind}:${party.id}`;
}

/**
 * Group into threads, newest conversation first, each thread oldest message
 * first — which is the order a conversation is read in.
 *
 * Unread counts only inbound messages. An outbound message nobody has "read" is
 * one the office sent itself.
 */
export function groupThreads(messages: readonly InboxMessage[]): Thread[] {
  const byKey = new Map<string, Thread>();

  for (const message of messages) {
    const party = partyOf(message);
    const key = threadKey(party);

    let thread = byKey.get(key);
    if (!thread) {
      thread = {
        key,
        party,
        name: nameFor(message, party),
        phone: message.direction === "inbound" ? message.fromAddress : message.toAddress,
        messages: [],
        lastAt: message.sentAt,
        unread: 0,
      };
      byKey.set(key, thread);
    }

    thread.messages.push(message);
    if (message.sentAt > thread.lastAt) thread.lastAt = message.sentAt;
    if (message.direction === "inbound" && !message.readAt) thread.unread += 1;

    // A later message may know a name an earlier one did not — the reply that
    // arrived before the customer record was created, for instance.
    if (thread.name === unknownName(thread.phone)) {
      const better = nameFor(message, party);
      if (better !== unknownName(thread.phone)) thread.name = better;
    }
    if (!thread.phone) {
      thread.phone = message.direction === "inbound" ? message.fromAddress : message.toAddress;
    }
  }

  const threads = [...byKey.values()];
  for (const thread of threads) {
    thread.messages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  // Unread first, then by recency. An inbox sorted purely by time buries the
  // one thing that needs answering under six automated reminders.
  return threads.sort((a, b) => {
    if ((a.unread > 0) !== (b.unread > 0)) return a.unread > 0 ? -1 : 1;
    return b.lastAt.getTime() - a.lastAt.getTime();
  });
}

function nameFor(message: InboxMessage, party: ThreadParty): string {
  switch (party.kind) {
    case "customer":
      return message.customerName || "Customer";
    case "lead":
      return message.leadName || "New enquiry";
    case "cleaner":
      return message.cleanerName || "Cleaner";
    case "unknown":
      return unknownName(message.fromAddress ?? message.toAddress);
  }
}

function unknownName(phone: string | null): string {
  return phone ? `Unknown · ${phone}` : "Unknown";
}
