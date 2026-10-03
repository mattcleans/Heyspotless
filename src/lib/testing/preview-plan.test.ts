import { describe, expect, it } from "vitest";
import { buildPreviewPlan, previewReadinessSql } from "./preview-plan";

const input = {
  projectRef: "abcdefghijklmnopqrst",
  appOrigin:
    "https://heyspotless-git-codex-three-role-ux-followup-hey-spotless.vercel.app",
  commitSha: "38663bed4c6c3a5849852e12cfb5caf803abb0c1",
  accounts: {
    executive: "b1111111-1111-4111-8111-111111111111",
    cleaner: "b2222222-2222-4222-8222-222222222222",
    client: "b3333333-3333-4333-8333-333333333333",
  },
  appliedMigrationVersions: ["0001"],
};
const migrations = [
  {
    file: "20261002020509_client_recurring_schedule_editor.sql",
    sha256: "c".repeat(64),
  },
  { file: "0001_init.sql", sha256: "a".repeat(64) },
  { file: "0002_price_book.sql", sha256: "b".repeat(64) },
];

describe("private preview preparation", () => {
  it("records exact migration hashes and separates applied from pending in order", () => {
    const manifest = JSON.parse(
      buildPreviewPlan(input, migrations).files["plan.json"],
    );
    expect(
      manifest.migrations.map((m: { version: string; applied: boolean }) => [
        m.version,
        m.applied,
      ]),
    ).toEqual([
      ["0001", true],
      ["0002", false],
      ["20261002020509", false],
    ]);
    expect(manifest.migrations[0].sha256).toBe("a".repeat(64));
    expect(manifest.commitSha).toBe(input.commitSha);
  });

  it.each([
    "swxaupitauibkatljfnt",
    "abtufqgsgwlbkaatyqyg",
    "echljmbayvksftkyqtus",
  ])("refuses known business or unrelated project %s", (projectRef) => {
    expect(() =>
      buildPreviewPlan({ ...input, projectRef }, migrations),
    ).toThrow();
  });
  it.each([
    "https://app.heyspotless.com",
    "https://heyspotless.vercel.app",
    "http://heyspotless-git-feature-hey-spotless.vercel.app",
    input.appOrigin + "/customer",
    input.appOrigin + "?token=private",
  ])("refuses non-preview origin %s", (appOrigin) => {
    expect(() =>
      buildPreviewPlan({ ...input, appOrigin }, migrations),
    ).toThrow();
  });
  it("rejects secret and unexpected input fields instead of copying them to artifacts", () => {
    expect(() =>
      buildPreviewPlan(
        { ...input, SUPABASE_SERVICE_ROLE_KEY: "private" },
        migrations,
      ),
    ).toThrow();
    expect(() =>
      buildPreviewPlan(
        { ...input, accounts: { ...input.accounts, password: "private" } },
        migrations,
      ),
    ).toThrow();
  });
  it("refuses shared role identities, invalid UUIDs and SQL-shaped IDs", () => {
    for (const cleaner of [
      input.accounts.client,
      "not-a-user",
      "'; drop table profiles; --",
    ]) {
      expect(() =>
        buildPreviewPlan(
          { ...input, accounts: { ...input.accounts, cleaner } },
          migrations,
        ),
      ).toThrow();
    }
  });
  it("rejects missing, unknown or duplicated remote migration history", () => {
    for (const appliedMigrationVersions of [
      ["0002"],
      ["0099"],
      ["0001", "0001"],
    ]) {
      expect(() =>
        buildPreviewPlan({ ...input, appliedMigrationVersions }, migrations),
      ).toThrow();
    }
  });
  it("rejects duplicate source versions, unsafe filenames and invalid hashes", () => {
    for (const extra of [
      { file: "0001_duplicate.sql", sha256: "d".repeat(64) },
      { file: "../0003_bad.sql", sha256: "d".repeat(64) },
      { file: "0003_bad.sql", sha256: "oops" },
    ])
      expect(() => buildPreviewPlan(input, [...migrations, extra])).toThrow();
  });
  it("prepares blank credentials, disabled providers, and the exact branch origin", () => {
    const env = buildPreviewPlan(input, migrations).files[
      "vercel-preview.env.example"
    ];
    expect(env).toContain(`NEXT_PUBLIC_APP_URL=${input.appOrigin}`);
    expect(env).toContain(`https://${input.projectRef}.supabase.co`);
    expect(env).toContain("DEMO_MODE=0");
    for (const flag of ["BILLING", "MESSAGING", "PUSH"])
      expect(env).toContain(`${flag}_ENABLED=0`);
    expect(env).toContain("SUPABASE_SERVICE_ROLE_KEY=\n");
    expect(env).not.toContain(input.accounts.client);
  });
  it("requires external target acknowledgement and fresh confirmed accounts before any role write", () => {
    const sql = buildPreviewPlan(input, migrations).files["fixture.sql"];
    expect(
      sql.indexOf("current_setting('spotless.preview_project_ref',true)"),
    ).toBeLessThan(sql.indexOf("insert into public.profiles"));
    expect(sql.indexOf("exists(select 1 from public.invoices)")).toBeLessThan(
      sql.indexOf("insert into public.profiles"),
    );
    expect(sql).toContain("email_confirmed_at is not null");
    expect(sql).toContain("Unmapped profiles present");
    expect(sql).toContain("Synthetic Preview Way");
    expect(sql).not.toMatch(/delete from|truncate|send.*email|record_payment/i);
  });
  it("checks actual RPC signatures and columns without invoking quote/confirm operations", () => {
    const sql = previewReadinessSql();
    expect(sql).toContain("request_my_visit_cleaner(uuid,uuid,uuid,text,uuid)");
    expect(sql).toContain(
      "respond_my_visit_backup(uuid,uuid,uuid,uuid,uuid,boolean,text,uuid)",
    );
    expect(sql).toContain("recurring_schedule_job_changes");
    expect(sql).toContain(
      "respond_to_offer_with_capacity(uuid,uuid,boolean,text)",
    );
    expect(sql).toContain(
      "assign_job_for_schedule_with_capacity(uuid,uuid,integer,bigint)",
    );
    expect(sql).toContain("has_function_privilege('service_role'");
    expect(sql).toContain("('offers','capacity_conflict_at')");
    expect(sql).toContain("('payouts','tip_net_cents')");
    expect(sql).toContain("has_function_privilege('anon'");
    expect(sql).toContain("relrowsecurity");
    expect(sql).not.toMatch(/insert into|update public|delete from/);
  });
});
