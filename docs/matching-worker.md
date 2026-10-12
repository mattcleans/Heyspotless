# Continuous matching worker

The Supabase worker retries pending matching every five minutes without relying
on Vercel's daily-only Hobby cron. It uses the same application executor,
eligibility, saved calendars, weekly hours, appointment/revision guards, offer
and assignment operations. It does not implement another pricing or matching model.

The build script follows actual TypeScript imports, generates runtime paths and
records raw source/template hashes. The pinned SDK comes from package-lock.json.
Generated files and config live outside the repository; they contain no credentials.
CI checks the resulting Deno dependency graph as well as application and SQL tests.

Generate an artifact from the exact published commit:

```bash
node scripts/build-matching-worker.mjs \
  --output /tmp/heyspotless-matching-worker \
  --project-ref YOUR_PROJECT_REF \
  --app-origin https://YOUR_APP_ORIGIN \
  --source-version FULL_PUBLISHED_COMMIT_SHA \
  --preview true
```

Deploy the generated entrypoint and all generated files with JWT verification
enabled. The gateway requires a valid JWT, and the handler additionally requires
a configured project-bound token, verified by a service-only database function.
The database retains its SHA-256 hash; the operator stores the token in Vault.
The operator can derive it by HMAC from a private service key, but the runtime
does not assume that its injected API-key string is identical. The cron uses
the public anonymous JWT plus that scoped token; the service key is not stored in
cron text or HTTP queues. The private HTTP extension sends the request directly
and bounds it to 90 seconds; Cron reports failure if the worker refuses or fails.
No credential-bearing pg_net queue is used. Neither ordinary signed-in accounts nor a public key
alone may run the worker.

Apply the lease/auth migrations and the hosted operator script in
supabase/operations/matching-worker.sql. Store configuration through the restricted
credential RPC from a private server tool; never put keys in chat, Git or command
arguments. It refuses implicit replacement of existing credentials. Validate a
protected GET, anonymous/ordinary-key refusal and an actual POST before registering
the five-minute cron statement shown in the script.

A database lease refuses overlapping workers and older completion callbacks.
Its single private status row records only numeric counters and success/failure.
Partial or unknown matching failures return an error and leave durable pending
visits available to a later run. Existing offer/capacity/write guards also protect
overlap with a Client kickoff or a manual operator sweep.

Preview artifacts force messaging, push and billing flags off. An actual worker
can still record offers, assignments and review decisions in its isolated database;
those intentional outcomes must be inspected before enabling recurring execution.
Production deployment, provider delivery/payment, physical devices and actual
Client/Management/Cleaner acceptance remain separate release gates.

At five-minute intervals, one worker makes about 8,640 invocations in a 30-day
month. Supabase includes 500,000 function invocations on Free; existing project
usage, database size and compute limits still need monitoring. See
[function scheduling](https://supabase.com/docs/guides/functions/schedule-functions)
and [current pricing](https://supabase.com/pricing).
