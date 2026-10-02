# Authenticated three-role preview acceptance

The preview must have its own Supabase development branch and branch-scoped Vercel environment. Account approval, a successful Vercel build, demo screenshots and green tests do not prove this setup. The current numbered schema version also cannot prove the timestamped workflow migrations are present.

`npm run preview:prepare -- .preview/input.json` prepares a private migration manifest, read-only catalog probes, synthetic fixture transaction and a Vercel environment template. It makes no network calls and performs no remote changes. Output files are ignored by Git, created in a new directory with private permissions and never contain API keys or passwords.

## Establish the target

1. Confirm the Supabase organization and branch cost before creating a development branch. Record the branch's project reference from `list_branches` and verify its parent is the business project. Supabase branches start without production data ([branching documentation](https://supabase.com/docs/guides/deployment/branching)). Do not copy production data or password hashes into the preview.
2. Inspect that branch's migration history. Reconcile any gaps or migrations absent from source; do not replay historical DDL blindly. The tool hashes every source migration and lists pending migrations in filename order. Apply pending migrations to the verified branch, then refresh the observed history and regenerate the plan. Do not run the default `supabase/seed.sql` on this target.
3. Create or verify three separate confirmed Auth accounts **in that branch**. Reuse authorized test email addresses, but do not grant a role in production or modify its accounts. The fixture assigns executive, cleaner and client roles only to the supplied preview UUIDs. Supabase supports server-side confirmed account creation without an invitation email ([Auth admin reference](https://supabase.com/docs/reference/javascript/auth-admin-createuser)); sign-in delivery still requires working preview Auth email settings. The app uses magic links, so a temporary password alone does not establish app access.
4. Populate the private input below using observed values, including the exact deployed source commit. Do not put credentials or email addresses in it. The example UUIDs/reference are placeholders, not provisioned accounts or a real project.

```json
{
  "projectRef": "abcdefghijklmnopqrst",
  "appOrigin": "https://heyspotless-git-codex-three-role-ux-followup-hey-spotless.vercel.app",
  "commitSha": "REPLACE_WITH_40_CHARACTER_DEPLOYED_COMMIT",
  "accounts": {
    "executive": "b1111111-1111-4111-8111-111111111111",
    "cleaner": "b2222222-2222-4222-8222-222222222222",
    "client": "b3333333-3333-4333-8333-333333333333"
  },
  "appliedMigrationVersions": []
}
```

## Bind and inspect the deployment

Set the generated environment values in Vercel **Preview**, scoped to the PR branch. Supply the branch's public and server-only keys in Vercel; never put the service key in a `NEXT_PUBLIC_` variable. Keep billing, messaging and push explicitly off, and omit provider credentials. Supply a preview-only cron secret for protected diagnostics. Vercel cron jobs run on production deployments; do not invoke a preview sweep until its target has been verified ([Vercel cron deployment documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs)).

Set the preview Auth Site URL to the exact branch origin and allow its `/auth/callback` URL. Resolve Vercel deployment protection access before requesting a sign-in link; an approved app account does not bypass Vercel protection. Redeploy after changing environment bindings.

Inspect the protected `/api/health` response using the preview-only cron secret. Verify the deployed commit, `environment=preview`, exact app origin, exact Supabase project URL, `demoMode=false`, reachable database and all three provider enablement flags false. Do not store the secret in the report. Run generated `readiness.sql` through a trusted connection to the verified branch. Every probe must report present, permitted and protected. These catalog checks prove required schema/grants exist; they do not prove role ownership, sign-in delivery, payment acceptance or browser behavior.

## Load synthetic visits

After verifying the connection target against the branch inventory, acknowledge that reference in the same trusted SQL session:

```sql
set spotless.preview_project_ref = 'REPLACE_WITH_VERIFIED_BRANCH_REF';
```

Then execute generated `fixture.sql`. The acknowledgement is an accidental-target guard, **not** proof of isolation. The fixture locks business tables and refuses any existing customers, properties, cleaners, jobs, plans or invoices; refuses unconfirmed/missing users and unmapped profiles; and checks workflow prerequisites before assigning roles. It never overwrites business data. Do not rerun it after acceptance changes; keep receipts/history and provision a fresh isolated branch if a clean reset is required.

The fixture creates one clearly synthetic client/home, two vetted synthetic cleaners (one linked to the test login), seven visits and a weekly plan. Two visits carry recorded accepted offers for the signed-in cleaner: one ordinary visit and one backup visit whose preferred cleaner differs, requiring the client to approve before work starts. A late appointment on the current Dallas day supports fee review; an advance visit supports free changes; three weekly dates support recurring edits. No invoice, payment, message or photo is seeded, so those acceptance results must be earned through the app. Relative sample visits are not a real booking or a promise of availability. If the day boundary has passed, use the current appointment dates shown in the UI rather than assuming the fee fixture is still today's visit.

## Record acceptance evidence

Use separate browser sessions for each role. Record the commit, target reference, route, Dallas appointment dates, expected result, observed result and receipt IDs; omit credentials and private contact details.

| Role      | Required acceptance                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Executive | Own role landing page; operations queue; linked client/cleaner/job records; preferred-cleaner review; current backup decline/release; photo access; scheduling audit and fee invoice labels.                                                                                                                             |
| Cleaner   | Assigned sample visible; own agreed earnings and hours; client home notes only for assigned work; backup start blocked until exact client approval; before/after evidence, interruption/retry, completion and own release history.                                                                                       |
| Client    | Own visits/home visible; masked gate code and conflicting edit recovery; backup accept/decline; Dallas $60 appointment-day cancellation/cross-day move and free same-day time change; earlier-day free change; stale review and retry receipt; recurring dates, frequency price review, pause/end dates and kept visits. |
| Isolation | Unassigned cleaner cannot read access notes/photos; client cannot read another client's visits/pay; client/cleaner cannot use executive operations; no anonymous workflow writes. Add a second synthetic client account/home in a reviewed separate fixture when testing cross-client isolation.                         |

Only mark authenticated acceptance complete after observing it. Physical-phone offline recovery and provider/payment acceptance need separate evidence; the disabled-provider preview cannot prove them. Keep the PR draft until release gates are satisfied.
