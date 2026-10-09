/** Prepare local files; never connect to or change a remote service. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPreviewPlan } from "../src/lib/testing/preview-plan.ts";

const [configPath, ...extra] = process.argv.slice(2);
if (!configPath || extra.length) {
  console.error("Usage: npm run preview:prepare -- .preview/input.json");
  process.exit(1);
}

try {
  const migrationDir = resolve("supabase/migrations");
  const migrations = await Promise.all(
    (await readdir(migrationDir))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map(async (file) => ({
        file,
        sha256: createHash("sha256")
          .update(await readFile(resolve(migrationDir, file)))
          .digest("hex"),
      })),
  );
  const plan = buildPreviewPlan(
    JSON.parse(await readFile(resolve(configPath), "utf8")),
    migrations,
  );
  // A new directory per run prevents replacing an already reviewed plan.
  const root = resolve(".preview");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = resolve(root, `${plan.projectRef}-${Date.now()}`);
  await mkdir(destination, { mode: 0o700 });
  for (const [name, content] of Object.entries(plan.files)) {
    await writeFile(resolve(destination, name), content, {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(
    `Prepared ${Object.keys(plan.files).length} files in ${destination}`,
  );
  console.log(
    "No remote calls, account changes, messages or payments were made.",
  );
  console.log("Follow docs/preview-acceptance.md before applying fixture.sql.");
} catch {
  // Do not echo parsed input or exceptions that might contain private values.
  console.error(
    "Preview preparation failed. Check the input against docs/preview-acceptance.md. No remote changes were made.",
  );
  process.exitCode = 1;
}
