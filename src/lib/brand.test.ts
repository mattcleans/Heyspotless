import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_BRAND,
  LEGAL_ENTITY,
  STATEMENT_DESCRIPTOR,
  invoiceChargeDescription,
} from "./brand";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The only files allowed to mention Bliss: the policy itself, this test, and
 * the setup checklist where Stripe/Twilio underwriting needs the registered
 * company. Customer-facing copy is not on the list.
 */
const BLISS_ALLOWLIST = new Set([
  "src/lib/brand.ts",
  "src/lib/brand.test.ts",
  "docs/setup.md",
]);

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".mts",
  ".md",
  ".sql",
  ".svg",
  ".css",
  ".json",
  ".yml",
  ".yaml",
  ".example",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, acc);
      continue;
    }
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    // .env.local holds secrets; never read it. The example file is copy, not keys.
    if (name.startsWith(".env") && name !== ".env.example") continue;
    if (name === ".env.example" || TEXT_EXT.has(ext)) acc.push(path);
  }
  return acc;
}

describe("the brand split", () => {
  it("names the customer brand Hey Spotless, not an invented LLC", () => {
    expect(CUSTOMER_BRAND).toBe("Hey Spotless");
    expect(CUSTOMER_BRAND).not.toMatch(/LLC/i);
  });

  it("keeps BLISS CLEANS LLC as the legal entity, which is ownership truth", () => {
    expect(LEGAL_ENTITY).toBe("BLISS CLEANS LLC");
  });

  it("prints a card-statement descriptor a customer would recognise", () => {
    expect(STATEMENT_DESCRIPTOR).toBe("HEY SPOTLESS");
    expect(STATEMENT_DESCRIPTOR.length).toBeGreaterThanOrEqual(5);
    expect(STATEMENT_DESCRIPTOR.length).toBeLessThanOrEqual(22);
    expect(STATEMENT_DESCRIPTOR).not.toMatch(/BLISS|LLC/i);
  });

  it("describes a Stripe charge as Hey Spotless, never Bliss", () => {
    const text = invoiceChargeDescription("abcdefghijkl");
    expect(text).toBe("Hey Spotless — invoice abcdefgh");
    expect(text).not.toMatch(/Bliss/i);
    expect(text).not.toMatch(/LLC/i);
  });
});

describe("the repo does not market Bliss or invent a second LLC", () => {
  const files = walk(ROOT).filter((path) => {
    const rel = relative(ROOT, path);
    return rel !== "package-lock.json";
  });

  it("contains no 'Hey Spotless LLC' — that company is not the registered entity", () => {
    const hits: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (rel === "src/lib/brand.test.ts") continue;
      const body = readFileSync(path, "utf8");
      if (/Hey Spotless LLC/i.test(body)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("keeps Bliss off customer-facing and public surfaces", () => {
    const hits: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (BLISS_ALLOWLIST.has(rel)) continue;
      const body = readFileSync(path, "utf8");
      if (/\bBliss\b/i.test(body)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("names the legal entity in setup, where Stripe and Twilio underwriting need it", () => {
    const setup = readFileSync(join(ROOT, "docs/setup.md"), "utf8");
    expect(setup).toContain(LEGAL_ENTITY);
    expect(setup).toContain(CUSTOMER_BRAND);
    expect(setup).not.toMatch(/Hey Spotless LLC/i);
  });
});
