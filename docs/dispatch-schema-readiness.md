# Dispatch database readiness

Dispatch preflight must establish that the deployed jobs query resolves, in addition to authenticating the scheduler and identifying the production database. A successful table count or an empty matching board does not prove that embedded relationships exist.

The protected `/api/health` report includes `database.jobReadReady`. It uses the same `JOB_SELECT` projection as `SupabaseRepository.listJobs`, requests `limit=0`, and has a five-second abort signal. It returns only a boolean; it neither changes rows nor returns homes, names, access instructions, or upstream error details. Public liveness remains `{ "ok": true }`.

The Dispatch sweep calls `verify-scheduler-target.mjs --require-dispatch-read`. It refuses dispatch when this capability is false or absent, including during a mixed deployment where the new workflow sees an older health response. It does not automatically run migrations or retry a dispatch after a failed preflight. The separate Automation sweep retains its own existing authentication/target checks and does not depend on this dispatch-only capability.

## Observed failure and recovery

On October 29, 2026, scheduled run [40973151886](https://github.com/mattcleans/Heyspotless/actions/runs/40973151886) passed scheduler authentication/production-target verification, then received HTTP 500 on all three dispatch attempts. Read-only production Supabase logs for 23:26:25–23:27:00 UTC show three successful `expire_stale_offers` RPC calls followed by three jobs GET requests rejected with HTTP 400 / `PGRST200`. Those requests embed `job_room_scopes`; that table is absent from production. The deployed source is `a20d80914ddf10620d89332f98105304d62b1951`.

1. Preserve the failed run and identify the deployed source/database; do not repeatedly run dispatch to diagnose reads.
2. Obtain and verify a production database backup and separate Storage object backup. Restore in isolation and rehearse the complete ordered release migrations, preserving business balances, pay, scope provenance, and existing objects.
3. Review the exact release and obtain specific production approval before changing schema or data. This readiness check does not grant that approval or repair the missing table.
4. Deploy the approved code/schema together. Confirm protected `database.jobReadReady=true`, target identity and configuration; inspect remaining required capabilities separately.
5. Verify the next authorized scheduled dispatch response and saved decisions. A true read probe is not proof of assignments, notifications, backup approval, billing, alerts, or successful business operation.

Do not bypass the read check, silently omit saved scope, fabricate confirmed historical room counts, or label a successful preflight as a completed dispatch run.
