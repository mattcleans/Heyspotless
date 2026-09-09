import { afterEach, describe, expect, it } from "vitest";
import { cronSecretMatches, hasStripeConfig, isBillingEnabled } from "./env";

const KEYS = ["DEMO_MODE", "BILLING_ENABLED", "STRIPE_SECRET_KEY", "CRON_SECRET"] as const;
const saved = new Map<string, string | undefined>();

function set(env: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("billing enablement", () => {
  it("is off with no Stripe key", () => {
    set({});
    expect(hasStripeConfig()).toBe(false);
    expect(isBillingEnabled()).toBe(false);
  });

  it("comes on once a key is configured", () => {
    set({ STRIPE_SECRET_KEY: "sk_test_x" });
    expect(isBillingEnabled()).toBe(true);
  });

  /** A demo must never be able to reach a live card, whatever else is set. */
  it("stays off in demo mode even with a key and the flag forced on", () => {
    set({ STRIPE_SECRET_KEY: "sk_test_x", BILLING_ENABLED: "1", DEMO_MODE: "1" });
    expect(isBillingEnabled()).toBe(false);
  });

  it("can be forced off while underwriting is pending", () => {
    set({ STRIPE_SECRET_KEY: "sk_test_x", BILLING_ENABLED: "0" });
    expect(isBillingEnabled()).toBe(false);
  });
});

describe("the cron secret", () => {
  it("accepts the configured secret", () => {
    set({ CRON_SECRET: "s3cret-value" });
    expect(cronSecretMatches("s3cret-value")).toBe(true);
  });

  it("rejects a wrong secret, including a prefix of the right one", () => {
    set({ CRON_SECRET: "s3cret-value" });
    expect(cronSecretMatches("s3cret-valuf")).toBe(false);
    expect(cronSecretMatches("s3cret")).toBe(false);
    expect(cronSecretMatches("s3cret-value-longer")).toBe(false);
  });

  /**
   * The failure that matters: with no CRON_SECRET configured, the endpoint must
   * be closed, not open to everyone. An empty presented secret must never
   * match an unset expected one.
   */
  it("rejects everything when no secret is configured", () => {
    set({});
    expect(cronSecretMatches("anything")).toBe(false);
    expect(cronSecretMatches("")).toBe(false);
    expect(cronSecretMatches(null)).toBe(false);
  });

  it("rejects a missing header when a secret is configured", () => {
    set({ CRON_SECRET: "s3cret-value" });
    expect(cronSecretMatches(null)).toBe(false);
    expect(cronSecretMatches("")).toBe(false);
  });
});
