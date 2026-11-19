import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The importer script itself, run as a process, the way it is run for real.
 *
 * On 9 November the line that writes the import was lost while a guard was
 * added beside it, and `--apply` went on printing a full report and "Next:
 * check the price audit" while writing nothing. These tests run the script
 * with no database settings: a real write must stop for want of them, and a
 * dry run must not need them.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURES = join(ROOT, "src/lib/migration/__fixtures__");

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "scripts/import-hcp.ts",
      "--customers", join(FIXTURES, "customers.csv"),
      "--jobs", join(FIXTURES, "jobs.csv"),
      "--today", "2026-11-19",
      ...args,
    ],
    { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 },
  );
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("the importer script", () => {
  it("tries to write on --apply, and stops without database settings", () => {
    const { status, out, err } = run("--apply");
    expect(out).toContain("writing:");
    expect(err).toContain("SUPABASE_SERVICE_ROLE_KEY must be set");
    expect(status).toBe(1);
  }, 60_000);

  it("writes nothing and needs no settings on a dry run", () => {
    const { status, out } = run("--dry-run");
    expect(status).toBe(0);
    expect(out).toContain("DRY RUN");
    expect(out).not.toContain("writing:");
  }, 60_000);

  it("announces a history-only run before anything else", () => {
    const { status, out } = run("--history-only", "--dry-run");
    expect(status).toBe(0);
    expect(out.indexOf("HISTORY ONLY")).toBeLessThan(out.indexOf("DRY RUN"));
    expect(out).toContain("every recurring plan is imported inactive");
  }, 60_000);
});
