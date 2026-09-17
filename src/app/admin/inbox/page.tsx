import Link from "next/link";
import { PageHeader, Pill } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { loadInbox } from "@/lib/messaging/inbox";
import { formatDateTimeInZone } from "@/lib/time/zone";
import type { Thread } from "@/lib/messaging/threads";
import { ReplyBox } from "./reply-box";

/**
 * Every conversation the business is having, in one place.
 *
 * WHAT THIS REPLACES. Today a customer's reply goes to a phone in somebody's
 * pocket, a cleaner's goes to a different one, and the answer to "what did we
 * tell them" is whoever remembers. The lead inbox in phase 07 is the same
 * screen with leads in it — which is why threads are keyed by party rather than
 * by customer.
 *
 * Read as the signed-in admin, under row-level security, rather than through
 * the service role. An inbox is the highest-value read in the system: it
 * contains addresses, gate codes people text, and every complaint.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Inbox — Spotless Ops" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const { thread: selectedKey } = await searchParams;

  if (isDemoMode()) {
    return (
      <>
        <PageHeader eyebrow="Admin" title="Inbox">
          Two-way SMS with customers, cleaners and leads.
        </PageHeader>
        <div className="card p-8 text-center text-sm text-ink-3">
          The inbox needs a live database and a Twilio number — there is nothing to show from
          fixtures, because every message in it arrived from somebody.
        </div>
      </>
    );
  }

  const threads = await loadInbox(await createClient());
  const selected = threads.find((t) => t.key === selectedKey) ?? threads[0] ?? null;
  const unreadTotal = threads.reduce((sum, t) => sum + t.unread, 0);

  return (
    <>
      <PageHeader eyebrow="Admin" title="Inbox">
        Every conversation, in one thread per person. Replies send from the business number;
        automated messages appear here alongside them, so what the platform said and what a
        person said are never two different records.
      </PageHeader>

      {threads.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-3">
          Nothing yet. Offers, reminders and anything a customer texts back will appear here.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
          <ThreadList threads={threads} selectedKey={selected?.key ?? null} unread={unreadTotal} />
          {selected ? <ThreadView thread={selected} /> : null}
        </div>
      )}
    </>
  );
}

function ThreadList({
  threads,
  selectedKey,
  unread,
}: {
  threads: Thread[];
  selectedKey: string | null;
  unread: number;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <p className="eyebrow">Threads</p>
        {unread > 0 ? <Pill tone="sky">{unread} unread</Pill> : null}
      </div>

      <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto">
        {threads.map((thread) => {
          const last = thread.messages[thread.messages.length - 1];
          return (
            <li key={thread.key}>
              <Link
                href={`/admin/inbox?thread=${encodeURIComponent(thread.key)}`}
                className={`block px-4 py-3 transition-colors hover:bg-surface-2 ${
                  thread.key === selectedKey ? "bg-surface-2" : ""
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p
                    className={`truncate text-sm ${
                      thread.unread > 0 ? "font-semibold text-navy" : "font-medium text-ink"
                    }`}
                  >
                    {thread.name}
                  </p>
                  {thread.unread > 0 ? <Pill tone="sky">{thread.unread}</Pill> : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-ink-3">{last?.body ?? ""}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ThreadView({ thread }: { thread: Thread }) {
  const target = {
    customerId: thread.party.kind === "customer" ? thread.party.id : null,
    cleanerId: thread.party.kind === "cleaner" ? thread.party.id : null,
    leadId: thread.party.kind === "lead" ? thread.party.id : null,
    phone: thread.party.kind === "unknown" ? thread.phone : null,
  };

  return (
    <div className="card flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div>
          <p className="font-semibold text-navy">{thread.name}</p>
          <p className="text-xs text-ink-3">{thread.phone ?? "no number"}</p>
        </div>
        <Pill>{thread.party.kind}</Pill>
      </div>

      <ol className="max-h-[26rem] space-y-3 overflow-y-auto p-4">
        {thread.messages.map((message) => (
          <li
            key={message.id}
            className={message.direction === "inbound" ? "" : "flex justify-end"}
          >
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                message.direction === "inbound"
                  ? "bg-surface-2 text-ink"
                  : "bg-sky/25 text-navy"
              }`}
            >
              <p className="whitespace-pre-wrap">{message.body}</p>
              <p className="mt-1 text-[10px] text-ink-3">
                {formatDateTimeInZone(message.sentAt)}
                {/*
                  Automated messages are labelled. The office needs to be able
                  to tell at a glance what the platform said on its own —
                  otherwise the first question on every complaint is "did one of
                  us send that?".
                */}
                {message.kind ? ` · ${message.kind}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <ReplyBox target={target} name={thread.name} />
    </div>
  );
}
