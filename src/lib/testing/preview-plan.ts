type Migration = { file: string; sha256: string };
type Input = {
  projectRef: string;
  appOrigin: string;
  commitSha: string;
  accounts: { executive: string; cleaner: string; client: string };
  appliedMigrationVersions: string[];
};

const liveProjects = new Set([
  "swxaupitauibkatljfnt", // Current business project.
  "abtufqgsgwlbkaatyqyg", // Old business project.
  "echljmbayvksftkyqtus", // Unrelated project.
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("object required");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== keys.sort().join(","))
    throw new Error("unexpected or missing field");
  return record;
}

function parse(value: unknown): Input {
  const input = object(value, [
    "projectRef",
    "appOrigin",
    "commitSha",
    "accounts",
    "appliedMigrationVersions",
  ]);
  if (
    typeof input.projectRef !== "string" ||
    !/^[a-z]{20}$/.test(input.projectRef) ||
    liveProjects.has(input.projectRef)
  )
    throw new Error("isolated project required");
  if (
    typeof input.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(input.commitSha)
  )
    throw new Error("exact commit required");
  if (typeof input.appOrigin !== "string")
    throw new Error("preview origin required");
  const url = new URL(input.appOrigin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^heyspotless-git-[a-z0-9-]+-hey-spotless\.vercel\.app$/.test(url.hostname)
  )
    throw new Error("branch preview origin required");
  const account = object(input.accounts, ["executive", "cleaner", "client"]);
  const ids = Object.values(account);
  if (
    ids.some((id) => typeof id !== "string" || !uuid.test(id)) ||
    new Set(ids.map((id) => (id as string).toLowerCase())).size !== 3
  )
    throw new Error("three distinct Auth user IDs required");
  const versions = input.appliedMigrationVersions;
  if (
    !Array.isArray(versions) ||
    versions.some(
      (v) => typeof v !== "string" || !/^(\d{4}|\d{14})$/.test(v),
    ) ||
    new Set(versions).size !== versions.length
  )
    throw new Error("observed migration versions required");
  return {
    projectRef: input.projectRef,
    appOrigin: url.origin,
    commitSha: input.commitSha,
    accounts: account as Input["accounts"],
    appliedMigrationVersions: versions,
  };
}

// Catalog probes are read-only and also work on the pre-workflow schema. They
// check signatures and permissions rather than calling a mutating quote RPC.
const functions = [
  "read_crew_lead_review(uuid)",
  "quote_crew_lead_replacement(uuid,uuid)",
  "confirm_crew_lead_replacement(uuid)",
  "withdraw_crew_lead_offer(uuid)",
  "read_my_crew_lead_offers()",
  "respond_my_crew_lead_offer(uuid,boolean)",
  "set_my_availability(jsonb)",
  "set_my_home_instructions(uuid,text,text,text,text,jsonb)",
  "request_my_visit_cleaner(uuid,uuid,uuid,text,uuid)",
  "respond_my_visit_backup(uuid,uuid,uuid,uuid,uuid,boolean,text,uuid)",
  "quote_my_visit_cancellation(uuid,text)",
  "confirm_my_visit_cancellation(uuid,uuid)",
  "quote_my_visit_reschedule_with_fee(uuid,timestamp with time zone)",
  "confirm_my_visit_reschedule(uuid,uuid)",
  "read_my_recurring_schedules(uuid,uuid)",
  "quote_my_recurring_schedule(uuid,date,frequency,time without time zone,date,date)",
  "confirm_my_recurring_schedule(uuid,uuid)",
  "read_my_visit_schedule_identity(uuid)",
  "read_my_recurring_visit_changes(uuid)",
];
const serverFunctions = [
  "respond_to_offer_with_capacity(uuid,uuid,boolean,text)",
  "assign_job_for_schedule_with_capacity(uuid,uuid,integer,bigint)",
];
const tables = [
  "crew_lead_releases",
  "visit_cleaner_requests",
  "visit_backup_decisions",
  "visit_backup_releases",
  "visit_cancellations",
  "visit_reschedules",
  "visit_reschedule_releases",
  "recurring_schedule_changes",
  "recurring_schedule_job_changes",
  "recurring_schedule_releases",
];
const columns = [
  ["payouts", "tip_net_cents"],
  ["jobs", "generation_epoch"],
  ["recurring_plans", "generation_epoch"],
  ["invoices", "kind"],
  ["offers", "capacity_conflict_at"],
];

export function previewReadinessSql(): string {
  return `-- Run against the verified preview project. Read-only, no account data.
with required_functions(signature) as (values
${functions.map((f) => ` ('public.${f}')`).join(",\n")}
), required_server_functions(signature) as (values
${serverFunctions.map((f) => ` ('public.${f}')`).join(",\n")}
), required_tables(name) as (values
${tables.map((t) => ` ('${t}')`).join(",\n")}
), required_columns(table_name,column_name) as (values
${columns.map(([t, c]) => ` ('${t}','${c}')`).join(",\n")}
)
select 'function' as kind, f.signature as name,
 to_regprocedure(f.signature) is not null as present,
 coalesce(has_function_privilege('authenticated',to_regprocedure(f.signature),'EXECUTE'),false) as permitted,
 coalesce(not has_function_privilege('anon',to_regprocedure(f.signature),'EXECUTE'),false) as protected
from required_functions f
union all
select 'server_function',f.signature,to_regprocedure(f.signature) is not null,
 coalesce(has_function_privilege('service_role',to_regprocedure(f.signature),'EXECUTE'),false),
 coalesce(not has_function_privilege('anon',to_regprocedure(f.signature),'EXECUTE')
  and not has_function_privilege('authenticated',to_regprocedure(f.signature),'EXECUTE'),false)
from required_server_functions f
union all
select 'table',t.name,c.oid is not null,
 coalesce(has_table_privilege('authenticated',c.oid,'SELECT'),false),coalesce(c.relrowsecurity,false)
from required_tables t left join pg_class c on c.oid=to_regclass('public.'||t.name)
union all
select 'column',r.table_name||'.'||r.column_name, exists(
 select 1 from information_schema.columns c where c.table_schema='public'
 and c.table_name=r.table_name and c.column_name=r.column_name),true,true
from required_columns r
order by kind,name;
`;
}

export function buildPreviewPlan(value: unknown, migrations: Migration[]) {
  const input = parse(value);
  const catalog = migrations
    .map((m) => {
      const match = /^(\d{4}|\d{14})_[a-z0-9_]+\.sql$/.exec(m.file);
      if (!match || !/^[0-9a-f]{64}$/.test(m.sha256))
        throw new Error("invalid migration manifest");
      return { ...m, version: match[1]! };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
  if (
    !catalog.length ||
    new Set(catalog.map((m) => m.version)).size !== catalog.length
  )
    throw new Error("unique migrations required");
  const known = new Set(catalog.map((m) => m.version));
  if (input.appliedMigrationVersions.some((v) => !known.has(v)))
    throw new Error("remote migration not in source; reconcile first");
  // A gap below an applied migration is drift, not a request to replay old DDL.
  const applied = new Set(input.appliedMigrationVersions);
  const highest = Math.max(
    -1,
    ...catalog.map((m, i) => (applied.has(m.version) ? i : -1)),
  );
  if (catalog.slice(0, highest + 1).some((m) => !applied.has(m.version)))
    throw new Error("migration gap; reconcile first");
  const manifest = {
    projectRef: input.projectRef,
    appOrigin: input.appOrigin,
    commitSha: input.commitSha,
    migrations: catalog.map((m) => ({ ...m, applied: applied.has(m.version) })),
    accounts: input.accounts,
    requires: [
      "Verified development branch identity",
      "Migrations and readiness probes pass",
      "Confirmed preview Auth users",
      "Preview deployment bound to branch keys",
      "Provider flags off",
      "Vercel access and exact Auth callback allowlist",
    ],
  };
  return {
    projectRef: input.projectRef,
    files: {
      "plan.json": JSON.stringify(manifest, null, 2) + "\n",
      "readiness.sql": previewReadinessSql(),
      "fixture.sql": fixture(input),
      "vercel-preview.env.example": `# Vercel Preview, branch-scoped only. Supply keys through Vercel.
DEMO_MODE=0
NEXT_PUBLIC_SUPABASE_URL=https://${input.projectRef}.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
BILLING_ENABLED=0
MESSAGING_ENABLED=0
PUSH_ENABLED=0
CRON_SECRET=
NEXT_PUBLIC_APP_URL=${input.appOrigin}
`,
    },
  };
}

function fixture(input: Input): string {
  const { executive, cleaner, client } = input.accounts;
  return `-- Synthetic preview fixtures. Never a production migration or default seed.
-- Target: ${input.projectRef}; source commit: ${input.commitSha}
-- Verify the branch identity externally before executing. This guard is an
-- accidental-target check, not proof of isolation. In the verified connection,
-- set spotless.preview_project_ref to '${input.projectRef}' first.
begin;
lock table public.customers,public.cleaners,public.properties,public.jobs,public.recurring_plans in share row exclusive mode;
do $$ begin
 if current_setting('spotless.preview_project_ref',true) is distinct from '${input.projectRef}' then
  raise exception 'Verified preview project acknowledgement required'; end if;
 if exists(select 1 from public.customers) or exists(select 1 from public.cleaners)
 or exists(select 1 from public.properties) or exists(select 1 from public.jobs)
 or exists(select 1 from public.recurring_plans) or exists(select 1 from public.invoices) then
  raise exception 'Fresh preview required; existing business rows are never overwritten'; end if;
 if (select count(*) from auth.users where id in ('${executive}','${cleaner}','${client}')
 and email_confirmed_at is not null)<>3 then
  raise exception 'Three confirmed preview Auth accounts required'; end if;
 if exists(select 1 from public.profiles where id not in ('${executive}','${cleaner}','${client}')) then
  raise exception 'Unmapped profiles present; reconcile preview accounts first'; end if;
 if to_regprocedure('public.confirm_my_recurring_schedule(uuid,uuid)') is null
 or to_regprocedure('public.quote_my_visit_reschedule_with_fee(uuid,timestamp with time zone)') is null then
  raise exception 'Apply complete workflow migration chain first'; end if;
end $$;
insert into public.profiles(id,role,full_name,email)
select u.id,case u.id when '${executive}'::uuid then 'admin'::public.user_role
 when '${cleaner}'::uuid then 'cleaner'::public.user_role else 'customer'::public.user_role end,
 case u.id when '${executive}'::uuid then 'Preview Executive'
 when '${cleaner}'::uuid then 'Preview Cleaner' else 'Preview Client' end,u.email
from auth.users u where u.id in ('${executive}','${cleaner}','${client}')
on conflict(id) do update set role=excluded.role,full_name=excluded.full_name,email=excluded.email;
insert into public.customers(id,profile_id,first_name,last_name,email,notes)
select 'a1111111-1111-4111-8111-111111111111','${client}','Preview','Client',email,
 'SYNTHETIC PREVIEW: no real client, address, message or payment.' from auth.users where id='${client}';
insert into public.properties(id,customer_id,street,city,zip,bedrooms,bathrooms,gate_code,access_notes,parking_notes,pets)
values('a2222222-2222-4222-8222-222222222222','a1111111-1111-4111-8111-111111111111',
 '100 Synthetic Preview Way','Dallas','75201',2,2,'PREVIEW-ONLY',
 'Synthetic instructions: use these only to test visibility and edits.','Synthetic parking note.','Synthetic pet note.');
insert into public.cleaners(id,profile_id,full_name,type,status,rating,acceptance_rate,background_check_cleared,insurance_expires_on,default_payout_rate,profile_published)
values('a3333333-3333-4333-8333-333333333333','${cleaner}','Preview Cleaner','contractor_1099','active',4.8,1,true,current_date+365,0.35,true),
 ('a4444444-4444-4444-8444-444444444444',null,'Preview Preferred Cleaner','contractor_1099','active',4.8,1,true,current_date+365,0.35,true);
insert into public.cleaner_availability(cleaner_id,day_of_week,starts_at,ends_at)
select c.id,d,'07:00','21:00' from public.cleaners c cross join generate_series(0,6) d;
insert into public.recurring_plans(id,customer_id,property_id,freq,service,agreed_price_cents,estimated_minutes,
 anchor_date,next_job_date,start_time,preferred_cleaner_id,agreed_payout_share,notes)
select 'a5555555-5555-4555-8555-555555555555','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222',
 'weekly','standard',q.total_cents,q.clean_minutes,
 (clock_timestamp() at time zone 'America/Chicago')::date+2,
 (clock_timestamp() at time zone 'America/Chicago')::date+2,'09:00','a3333333-3333-4333-8333-333333333333',0.35,
 'SYNTHETIC PREVIEW: recurring editor and generation acceptance.'
from public.quote_price('standard','weekly',2,2) q;
insert into public.jobs(id,customer_id,property_id,status,service,freq,scheduled_start,scheduled_end,price_cents,
 estimated_clean_minutes,preferred_cleaner_id,agreed_payout_share,notes)
select v.id::uuid,'a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222',
 'scheduled','standard','one_time',v.start_at,v.start_at+q.clean_minutes*interval '1 minute',q.total_cents,q.clean_minutes,
 v.preferred::uuid,0.35,v.note
from (values
 ('a6666666-6666-4666-8666-666666666661',date_trunc('minute',clock_timestamp())+interval '30 minutes','a3333333-3333-4333-8333-333333333333','SYNTHETIC PREVIEW: own assigned visit, photos and completion.'),
 ('a6666666-6666-4666-8666-666666666662',date_trunc('minute',clock_timestamp())+interval '4 hours','a4444444-4444-4444-8444-444444444444','SYNTHETIC PREVIEW: this backup must be approved by the client before start.'),
 ('a6666666-6666-4666-8666-666666666663',((clock_timestamp() at time zone 'America/Chicago')::date+time '23:59') at time zone 'America/Chicago','a3333333-3333-4333-8333-333333333333','SYNTHETIC PREVIEW: appointment-day fee and free time-change review; never start this visit.'),
 ('a6666666-6666-4666-8666-666666666664',((clock_timestamp() at time zone 'America/Chicago')::date+3+time '11:00') at time zone 'America/Chicago','a3333333-3333-4333-8333-333333333333','SYNTHETIC PREVIEW: advance cancellation and rescheduling.'))
as v(id,start_at,preferred,note) cross join lateral public.quote_price('standard','one_time',2,2) q;
insert into public.offers(job_id,cleaner_id,channel,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,status,expires_at)
select id,'a3333333-3333-4333-8333-333333333333','waterfall',round(price_cents*0.35*60/estimated_clean_minutes)::integer,
 round(price_cents*0.35)::integer,0.35,estimated_clean_minutes,'accepted',now()+interval '1 day'
from public.jobs where id in ('a6666666-6666-4666-8666-666666666661','a6666666-6666-4666-8666-666666666662');
insert into public.job_assignments(job_id,cleaner_id,offer_id,payout_cents)
select job_id,cleaner_id,id,payout_cents from public.offers;
update public.jobs set status='assigned' where id in ('a6666666-6666-4666-8666-666666666661','a6666666-6666-4666-8666-666666666662');
select public.materialise_recurring_job('a5555555-5555-4555-8555-555555555555',
 ((clock_timestamp() at time zone 'America/Chicago')::date+n)::date,null)
from (values(2),(9),(16)) v(n);
commit;
-- Do not run again after testing. Inspect the saved plan and per-role UI.
`;
}
