import { describe, expect, it } from "vitest";
import {
  EMPTY_TWIML,
  formParams,
  interpret,
  twilioSignatureFor,
  verifyTwilioSignature,
} from "./inbound";

const TOKEN = "an-auth-token-that-is-not-real";
const URL = "https://app.heyspotless.com/api/twilio/inbound";

function params(over: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: "AC00000000000000000000000000000000",
    Body: "Can we move Tuesday?",
    From: "+12145550143",
    MessageSid: "SM00000000000000000000000000000001",
    To: "+19725550100",
    ...over,
  };
}

describe("verifyTwilioSignature", () => {
  it("accepts a signature it computed itself", () => {
    const p = params();
    const signature = twilioSignatureFor(URL, p, TOKEN);
    expect(verifyTwilioSignature(URL, p, TOKEN, signature)).toBe(true);
  });

  /**
   * The whole reason the endpoint verifies. Unsigned, anyone who finds the URL
   * can forge a text from any number in the book — and, because STOP is
   * honoured by number, opt a cleaner out of the offers that are her income.
   */
  it("refuses a request with no signature", () => {
    expect(verifyTwilioSignature(URL, params(), TOKEN, null)).toBe(false);
    expect(verifyTwilioSignature(URL, params(), TOKEN, "")).toBe(false);
  });

  it("refuses a body that was changed after signing", () => {
    const signature = twilioSignatureFor(URL, params(), TOKEN);
    const tampered = params({ Body: "STOP" });
    expect(verifyTwilioSignature(URL, tampered, TOKEN, signature)).toBe(false);
  });

  it("refuses a sender that was changed after signing", () => {
    const signature = twilioSignatureFor(URL, params(), TOKEN);
    const tampered = params({ From: "+12145559999" });
    expect(verifyTwilioSignature(URL, tampered, TOKEN, signature)).toBe(false);
  });

  it("refuses a signature made with a different token", () => {
    const signature = twilioSignatureFor(URL, params(), "the-old-token");
    expect(verifyTwilioSignature(URL, params(), TOKEN, signature)).toBe(false);
  });

  /**
   * The signature covers the URL, so a signature captured from the staging
   * endpoint cannot be replayed against production.
   */
  it("refuses a signature made for a different URL", () => {
    const signature = twilioSignatureFor("https://staging.example.com/api/twilio/inbound", params(), TOKEN);
    expect(verifyTwilioSignature(URL, params(), TOKEN, signature)).toBe(false);
  });

  /** Parameter order is the caller's, not Twilio's; the algorithm sorts. */
  it("does not depend on the order the parameters arrive in", () => {
    const forward = twilioSignatureFor(URL, params(), TOKEN);
    const reversed = Object.fromEntries(Object.entries(params()).reverse());
    expect(twilioSignatureFor(URL, reversed, TOKEN)).toBe(forward);
  });

  it("covers every parameter, not only the ones the handler reads", () => {
    const withExtra = twilioSignatureFor(URL, params({ NumMedia: "1" }), TOKEN);
    expect(withExtra).not.toBe(twilioSignatureFor(URL, params(), TOKEN));
  });

  it("does not throw on a signature of a different length", () => {
    expect(verifyTwilioSignature(URL, params(), TOKEN, "short")).toBe(false);
  });
});

describe("interpret", () => {
  it("reads the opt-out words carriers require", () => {
    for (const word of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "cancel", "QUIT", "end"]) {
      expect(interpret(word).kind).toBe("opt_out");
    }
  });

  it("reads the opt-in words", () => {
    for (const word of ["START", "unstop", "Yes"]) {
      expect(interpret(word).kind).toBe("opt_in");
    }
  });

  it("reads HELP", () => {
    expect(interpret("help").kind).toBe("help");
    expect(interpret("INFO").kind).toBe("help");
  });

  /**
   * The case that decides between a keyword matcher and a substring one. A
   * customer asking us to stop doing something specific has not unsubscribed,
   * and treating it as an opt-out silences every reminder they were relying on.
   */
  it("does not treat a sentence containing a keyword as a keyword", () => {
    expect(interpret("please stop sending the cleaner to the side door").kind).toBe("message");
    expect(interpret("can we cancel Tuesday?").kind).toBe("message");
    expect(interpret("yes please, Thursday works").kind).toBe("message");
  });

  it("treats anything else as something a person has to answer", () => {
    expect(interpret("Can we move Tuesday?").kind).toBe("message");
    expect(interpret("").kind).toBe("message");
  });
});

describe("formParams", () => {
  it("keeps every parameter, because the signature covers every parameter", () => {
    const body = new URLSearchParams("Body=hi&From=%2B12145550143&NumMedia=0");
    expect(formParams(body)).toEqual({ Body: "hi", From: "+12145550143", NumMedia: "0" });
  });
});

describe("EMPTY_TWIML", () => {
  it("is a well-formed empty response, not an empty body", () => {
    expect(EMPTY_TWIML).toContain("<Response></Response>");
    expect(EMPTY_TWIML.startsWith("<?xml")).toBe(true);
  });
});
