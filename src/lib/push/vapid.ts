import { createSign, createPrivateKey, createPublicKey } from "node:crypto";

/**
 * The half of Web Push that has to be got exactly right.
 *
 * VAPID is how a push service (Apple's, Google's, Mozilla's) knows the push is
 * from us. It is an ES256 JWT over `{aud, exp, sub}`, signed with the private
 * key whose public half the browser was given when it subscribed. Get any part
 * of it wrong and the push service answers 401 with no explanation, for ever,
 * silently — which is why this file is separate and tested.
 *
 * WHY THERE IS NO PAYLOAD ENCRYPTION HERE, and why that is a design choice
 * rather than a gap. RFC 8291 lets a push carry an encrypted body; implementing
 * it means ECDH against the subscription's key, HKDF, and AES-128-GCM. This
 * sends a push with NO body instead — a tickle — and the service worker fetches
 * the offer from our own API when it wakes. That is:
 *
 *   * less code, and none of it cryptography we wrote ourselves;
 *   * more current — the worker fetches the offer as it is NOW, not as it was
 *     when the push was queued, which matters when a rung lives 8 to 15
 *     minutes and somebody else may already have taken the job;
 *   * and better for the cleaner, because the address and the payout never
 *     transit Apple's or Google's infrastructure at all.
 *
 * The cost is that a push cannot be shown while the device is offline, which is
 * the correct trade for a marketplace where an offer she cannot answer is worse
 * than no offer.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function vapidKeys(): VapidKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;

  return {
    publicKey,
    privateKey,
    // Push services require a contact for the sender. A mailto: is what the
    // spec asks for and what Apple's service actually checks.
    subject: process.env.VAPID_SUBJECT || "mailto:hey@heyspotless.com",
  };
}

export function hasPushConfig(): boolean {
  return vapidKeys() !== null;
}

export function isPushEnabled(): boolean {
  if (process.env.DEMO_MODE === "1") return false;
  if (process.env.PUSH_ENABLED === "0") return false;
  if (process.env.PUSH_ENABLED === "1") return true;
  return hasPushConfig();
}

/** base64url, which is what every part of this protocol uses and `base64` is not. */
export function toBase64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * The audience of the JWT: the push service's ORIGIN, not the endpoint.
 *
 * A JWT signed for the full endpoint URL is rejected, and the rejection is a
 * bare 401. This is the single commonest reason a Web Push integration never
 * delivers anything.
 */
export function audienceFor(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * The `Authorization` header for one push.
 *
 * Signed per push service rather than per push: the audience is the service's
 * origin, so one header covers every subscription on the same service and a
 * sweep pushing to forty cleaners signs two or three JWTs rather than forty.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now: Date = new Date(),
  ttlSeconds = 12 * 3600,
): string {
  const header = toBase64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = toBase64Url(
    JSON.stringify({
      aud: audienceFor(endpoint),
      // Twelve hours. The spec caps it at 24; shorter means a leaked token is
      // worth less, and longer buys nothing because these are made per sweep.
      exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
      sub: keys.subject,
    }),
  );

  const signature = signEs256(`${header}.${payload}`, keys.privateKey);

  return `vapid t=${header}.${payload}.${signature}, k=${keys.publicKey}`;
}

/**
 * ES256 over the signing input, in the JOSE encoding.
 *
 * `createSign` produces DER, which JOSE does not accept — it wants the raw
 * 64-byte r‖s concatenation. Node will do the conversion given
 * `dsaEncoding: "ieee-p1363"`, and asking for it is the whole trick.
 */
function signEs256(input: string, privateKeyBase64Url: string): string {
  const key = privateKeyFrom(privateKeyBase64Url);

  const signature = createSign("SHA256")
    .update(input)
    .sign({ key, dsaEncoding: "ieee-p1363" });

  return toBase64Url(signature);
}

/**
 * A P-256 private key from the 32 raw bytes `web-push` style keys are
 * distributed as.
 *
 * Node cannot import raw scalar bytes directly, so they are wrapped in the
 * minimal PKCS#8 envelope for `prime256v1`. The prefix is fixed: it is the
 * ASN.1 for "this is a P-256 private key and here are the 32 bytes".
 *
 * A PEM key is passed through untouched, because that is what somebody who
 * generated theirs with openssl will have.
 */
function privateKeyFrom(raw: string) {
  if (raw.includes("BEGIN")) return createPrivateKey(raw);

  const bytes = fromBase64Url(raw);
  if (bytes.length !== 32) {
    throw new Error(
      `VAPID_PRIVATE_KEY must be 32 bytes (got ${bytes.length}). ` +
        "Generate a pair with `npm run push:keys`.",
    );
  }

  const pkcs8 = Buffer.concat([
    Buffer.from("308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex"),
    bytes,
  ]);

  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

/**
 * The public key as the browser needs it: 65 raw bytes, uncompressed P-256.
 *
 * Exported so `npm run push:keys` and the subscribe endpoint agree about what a
 * key looks like — a mismatch here produces subscriptions that can never be
 * pushed to, and nothing says so until nobody gets a notification.
 */
export function publicKeyFromPrivate(privateKeyBase64Url: string): string {
  const publicKey = createPublicKey(privateKeyFrom(privateKeyBase64Url));
  const der = publicKey.export({ format: "der", type: "spki" });
  // The last 65 bytes of the SPKI DER are the uncompressed point.
  return toBase64Url(der.subarray(der.length - 65));
}
