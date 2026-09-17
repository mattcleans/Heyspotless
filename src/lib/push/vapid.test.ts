import { describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  audienceFor,
  fromBase64Url,
  publicKeyFromPrivate,
  toBase64Url,
  vapidAuthorization,
  type VapidKeys,
} from "./vapid";

/**
 * Every failure in this file looks the same in production: a bare 401 from a
 * push service, for ever, with nobody notified. So it is asserted here instead.
 */

function keys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  // The 32 raw scalar bytes, which is how VAPID keys are distributed.
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  const der = publicKey.export({ format: "der", type: "spki" });

  return {
    privateKey: jwk.d!,
    publicKey: toBase64Url(der.subarray(der.length - 65)),
    subject: "mailto:hey@heyspotless.com",
  };
}

describe("audienceFor", () => {
  /**
   * THE COMMONEST REASON A WEB PUSH INTEGRATION NEVER DELIVERS ANYTHING. A JWT
   * signed for the full endpoint URL is rejected, and the rejection is a bare
   * 401 with no body.
   */
  it("is the push service's origin, never the endpoint", () => {
    expect(audienceFor("https://web.push.apple.com/abc123/def")).toBe(
      "https://web.push.apple.com",
    );
    expect(audienceFor("https://fcm.googleapis.com/fcm/send/xyz")).toBe(
      "https://fcm.googleapis.com",
    );
  });
});

describe("vapidAuthorization", () => {
  it("produces a header the push service can actually verify", () => {
    const k = keys();
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", k);

    const token = /t=([^,]+)/.exec(header)?.[1];
    expect(token).toBeTruthy();

    const [h, p, signature] = token!.split(".");
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
        fromBase64Url(k.publicKey),
      ]),
      format: "der",
      type: "spki",
    });

    // The signature has to verify in the JOSE encoding — DER, which
    // createSign produces by default, is silently rejected by every service.
    expect(
      verify(
        "SHA256",
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        fromBase64Url(signature!),
      ),
    ).toBe(true);
  });

  it("carries the key the browser subscribed with", () => {
    const k = keys();
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", k);
    expect(header).toContain(`k=${k.publicKey}`);
  });

  it("claims the right audience, subject and expiry", () => {
    const k = keys();
    const now = new Date("2026-09-17T12:00:00Z");
    const header = vapidAuthorization("https://web.push.apple.com/abc", k, now, 3600);

    const payload = JSON.parse(
      fromBase64Url(/t=([^,]+)/.exec(header)![1]!.split(".")[1]!).toString("utf8"),
    ) as { aud: string; sub: string; exp: number };

    expect(payload.aud).toBe("https://web.push.apple.com");
    expect(payload.sub).toBe("mailto:hey@heyspotless.com");
    expect(payload.exp).toBe(Math.floor(now.getTime() / 1000) + 3600);
  });

  /** Apple checks this one. An expiry past 24 hours is refused outright. */
  it("stays inside the 24-hour cap the spec sets", () => {
    const k = keys();
    const now = new Date("2026-09-17T12:00:00Z");
    const payload = JSON.parse(
      fromBase64Url(
        /t=([^,]+)/.exec(vapidAuthorization("https://fcm.googleapis.com/x", k, now))![1]!
          .split(".")[1]!,
      ).toString("utf8"),
    ) as { exp: number };

    expect(payload.exp - Math.floor(now.getTime() / 1000)).toBeLessThanOrEqual(24 * 3600);
  });
});

describe("publicKeyFromPrivate", () => {
  /**
   * A mismatch here produces subscriptions that can never be pushed to, and
   * nothing says so until nobody gets a notification.
   */
  it("derives the same public key the browser was given", () => {
    const k = keys();
    expect(publicKeyFromPrivate(k.privateKey)).toBe(k.publicKey);
  });

  it("refuses a key of the wrong length rather than signing with rubbish", () => {
    expect(() => publicKeyFromPrivate(toBase64Url(Buffer.alloc(16)))).toThrow(/32 bytes/);
  });
});

describe("base64url", () => {
  it("round-trips, and uses the URL alphabet", () => {
    const bytes = Buffer.from([251, 255, 190, 0]);
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(fromBase64Url(encoded)).toEqual(bytes);
  });
});
