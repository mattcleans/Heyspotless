/**
 * Whether a failed send is worth trying again.
 *
 * WHAT THIS FIXES, AND IT WAS FOUND IN PRODUCTION. The messaging gateway has
 * always classified its failures: a 4xx is ours and will fail identically next
 * time — an unreachable number, an unregistered sender, a missing credential —
 * while a 5xx, a 429 or a timeout is the provider's and is worth another go.
 * The automation sweep ignored that classification entirely and treated every
 * failure as retryable.
 *
 * The result, on 19 September, was an hourly red workflow run:
 *
 *   {"due":2,"sent":0,"failed":2,"problems":[
 *     {"error":"Twilio is not configured. Set TWILIO_ACCOUNT_SID, …"}]}
 *
 * A missing credential is not a transient fault. Retrying it every hour cannot
 * fix it, burns one of the four attempts each time, and — because `failed` is
 * what fails the workflow — turns a configuration problem into a recurring
 * build failure that says nothing new on the twentieth repetition. An alert
 * that fires every hour for something nobody can act on from the alert is an
 * alert people learn to close.
 *
 * So a permanent failure is now settled rather than released: recorded with its
 * reason, marked fired, and never tried again. The queue moves on, the reason
 * stays on the row for whoever asks why that customer got no reminder, and the
 * workflow goes red only for failures that might genuinely be different next
 * time.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not make the message send. A
 * cleaner or a customer still gets nothing until the credential is there. It
 * stops the system from mistaking "will never work" for "try again in an hour".
 */

export type SendOutcome =
  /** Recorded, marked fired, never retried. The reason is on the row. */
  | { kind: "skipped"; reason: string }
  /** Released for the next sweep, and counted against the attempt limit. */
  | { kind: "failed"; reason: string };

export function outcomeForFailedSend(reason: string, retryable: boolean): SendOutcome {
  if (retryable) return { kind: "failed", reason };

  // Prefixed so the row says plainly why it stopped rather than looking like
  // something that was never attempted.
  return { kind: "skipped", reason: `not retryable — ${reason}` };
}
