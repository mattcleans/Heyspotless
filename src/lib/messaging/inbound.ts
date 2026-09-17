import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What arrives, and whether to believe it.
 *
 * Pure, and separate from the route for the same reason the send decision is
 * separate from the send: the interesting cases here are all decided by a
 * string, and a string is something a test can produce without a Twilio
 * account, a tunnel, or a phone.
 */

// ------------------------------------------------------------- signature ---

/**
 * Twilio signs every webhook. Verifying it is not optional.
 *
 * The endpoint is a public URL that takes a phone number and a message body and
 * writes both into the customer record they appear to come from. Unverified,
 * anyone who finds it can forge a text from any number in the book — and, since
 * STOP is honoured by number, opt a cleaner out of the offers that are her
 * income. That is the whole attack, and it is two curl commands.
 *
 * THE ALGORITHM, because it is unusual enough to get wrong: take the exact URL
 * Twilio requested, append every POST parameter as key then value with the keys
 * in lexicographic order, HMAC-SHA1 it with the account's auth token, and
 * base64 the result.
 *
 * The URL has to be the one TWILIO used, not the one the app thinks it is
 * serving. Behind Vercel's proxy `request.url` can differ from the public URL
 * in scheme or host, and either difference produces a valid signature that
 * fails to match — which is why the route passes an explicitly constructed URL
 * rather than whatever the framework hands it.
 */
export function twilioSignatureFor(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  return createHmac("sha1", authToken).update(Buffer.from(payload, "utf8")).digest("base64");
}

/**
 * Constant-time compare, because a signature check that leaks its answer a
 * character at a time through response timing is not a signature check.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
  presented: string | null,
): boolean {
  if (!presented) return false;

  const expected = Buffer.from(twilioSignatureFor(url, params, authToken), "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

// -------------------------------------------------------------- keywords ---

/**
 * The words carriers require us to honour.
 *
 * Twilio's Advanced Opt-Out answers these at the carrier level whether or not
 * this app does anything, and that is exactly why the app must ALSO record
 * them. The carrier stops delivering; our database goes on believing she is
 * reachable, goes on writing offers she will never see, and goes on counting
 * each expiry against the acceptance rate that decides what work she is shown.
 * The compliance half is handled upstream. The half that matters to her
 * livelihood is handled here.
 *
 * Matched on the whole message, trimmed and case-folded, never on "contains":
 * a customer writing "please stop sending the cleaner to the side door" has not
 * opted out of anything.
 */
const OPT_OUT_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "revoke",
  "optout",
  "opt out",
]);

const OPT_IN_WORDS = new Set(["start", "unstop", "yes", "optin", "opt in"]);

const HELP_WORDS = new Set(["help", "info"]);

export type InboundIntent =
  | { kind: "opt_out"; word: string }
  | { kind: "opt_in"; word: string }
  | { kind: "help" }
  | { kind: "message" };

export function interpret(body: string): InboundIntent {
  const word = body.trim().toLowerCase().replace(/\s+/g, " ");

  if (OPT_OUT_WORDS.has(word)) return { kind: "opt_out", word };
  if (OPT_IN_WORDS.has(word)) return { kind: "opt_in", word };
  if (HELP_WORDS.has(word)) return { kind: "help" };
  return { kind: "message" };
}

/**
 * An empty TwiML document.
 *
 * Twilio reads the response body as instructions. Returning nothing sensible —
 * a JSON object, an empty 200 with the wrong content type — is read as a
 * malformed response and logged as an error against the number, which over
 * time is how a messaging service acquires a reputation problem.
 *
 * Empty is the right instruction here: STOP, START and HELP are answered by the
 * carrier's own auto-reply, and a customer's actual message is answered by a
 * person in the inbox, not by a robot at 11pm.
 */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Form-encoded body to a plain object.
 *
 * Twilio posts `application/x-www-form-urlencoded`, and the signature is
 * computed over every parameter, so this has to preserve all of them — not
 * only the four the handler cares about.
 */
export function formParams(raw: URLSearchParams): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of raw.entries()) params[key] = value;
  return params;
}
