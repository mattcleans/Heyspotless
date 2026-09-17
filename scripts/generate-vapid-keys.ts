/**
 * Generate the VAPID key pair for Web Push.
 *
 *   npm run push:keys
 *
 * Run once. The public key goes to browsers when they subscribe; the private
 * key signs every push and goes into Vercel and nowhere else. ROTATING THEM
 * INVALIDATES EVERY EXISTING SUBSCRIPTION — every cleaner has to turn
 * notifications back on — so this is not a thing to re-run casually.
 */

import { generateKeyPairSync } from "node:crypto";
import { publicKeyFromPrivate, toBase64Url } from "../src/lib/push/vapid.ts";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
const der = publicKey.export({ format: "der", type: "spki" });

const priv = jwk.d;
const pub = toBase64Url(der.subarray(der.length - 65));

if (!priv) {
  console.error("could not export the private key");
  process.exit(1);
}

// Proves the pair agrees before anybody pastes it into Vercel. A mismatch here
// produces subscriptions that can never be pushed to, and nothing says so until
// nobody gets a notification.
if (publicKeyFromPrivate(priv) !== pub) {
  console.error("the generated pair does not agree with itself — do not use it");
  process.exit(1);
}

console.log(`VAPID_PUBLIC_KEY=${pub}`);
console.log(`VAPID_PRIVATE_KEY=${priv}`);
console.log(`VAPID_SUBJECT=mailto:hey@heyspotless.com`);
console.log(
  "\nPublic key: safe to ship to browsers.\n" +
    "Private key: Vercel environment only. Never in the repo, never in a chat.\n" +
    "Rotating these makes every cleaner re-enable notifications.",
);
