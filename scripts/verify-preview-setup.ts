/** Emits SQL for the empty disposable verifier database; never connects. */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { buildPreviewPlan } from "../src/lib/testing/preview-plan.ts";

const migrations = await Promise.all(
  (await readdir("supabase/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .map(async (file) => ({
      file,
      sha256: createHash("sha256")
        .update(await readFile(`supabase/migrations/${file}`))
        .digest("hex"),
    })),
);
const plan = buildPreviewPlan(
  {
    projectRef: "abcdefghijklmnopqrst",
    appOrigin:
      "https://heyspotless-git-codex-three-role-ux-followup-hey-spotless.vercel.app",
    commitSha: "0".repeat(40),
    accounts: {
      executive: "b1111111-1111-4111-8111-111111111111",
      cleaner: "b2222222-2222-4222-8222-222222222222",
      client: "b3333333-3333-4333-8333-333333333333",
    },
    appliedMigrationVersions: [],
  },
  migrations,
);
const body = plan.files["fixture.sql"]
  .replace(/^begin;\n/m, "")
  .replace(/^commit;\n/m, "");
const quotedBody = "'" + body.replaceAll("'", "''") + "'";
const readiness = plan.files["readiness.sql"].trim().replace(/;$/, "");

function rejection(message: string) {
  return `do $verify$ begin
 begin
  execute ${quotedBody};
  raise exception 'Fixture unexpectedly succeeded';
 exception when raise_exception then
  if position('${message}' in sqlerrm)=0 then raise; end if;
 end;
end $verify$;`;
}

console.log(`-- Generated preview fixture verification. All data/schema changes roll back.
begin;
alter table auth.users add column email_confirmed_at timestamptz;
insert into auth.users(id,email,email_confirmed_at) values
 ('b1111111-1111-4111-8111-111111111111','executive@example.test',now()),
 ('b2222222-2222-4222-8222-222222222222','cleaner@example.test',now()),
 ('b3333333-3333-4333-8333-333333333333','client@example.test',null);
${rejection("acknowledgement required")}
set local spotless.preview_project_ref='abcdefghijklmnopqrst';
${rejection("confirmed preview Auth accounts required")}
update auth.users set email_confirmed_at=now();
${body}
do $verify$ begin
 if exists(select 1 from (${readiness}) p where not p.present or not p.permitted or not p.protected) then
  raise exception 'Preview catalog readiness failed'; end if;
 if (select count(*) from public.jobs)<>7 or (select count(*) from public.job_assignments)<>2
 or (select count(*) from public.recurring_plans)<>1 or exists(select 1 from public.invoices)
 or (select count(*) from public.offers where status='accepted')<>2 then
  raise exception 'Preview fixture shape failed'; end if;
 if (select role from public.profiles where id='b1111111-1111-4111-8111-111111111111')<>'admin'
 or (select role from public.profiles where id='b2222222-2222-4222-8222-222222222222')<>'cleaner'
 or (select role from public.profiles where id='b3333333-3333-4333-8333-333333333333')<>'customer' then
  raise exception 'Preview roles failed'; end if;
end $verify$;
${rejection("existing business rows are never overwritten")}
set local request.jwt.claim.sub='b3333333-3333-4333-8333-333333333333';
set local role authenticated;
do $verify$ begin
 if jsonb_array_length(public.read_my_recurring_schedules(null,null))<>1 then
  raise exception 'Preview own-client schedule missing'; end if;
end $verify$;
reset role;
-- Job start is a server-only RPC. The app checks own assignment before calling.
set local request.jwt.claim.sub='b2222222-2222-4222-8222-222222222222';
do $verify$ begin
 begin
  perform public.start_job('a6666666-6666-4666-8666-666666666662','a3333333-3333-4333-8333-333333333333');
  raise exception 'Unapproved preview backup started';
 exception when sqlstate 'PBC01' then null;
 end;
end $verify$;
set local request.jwt.claim.sub='b3333333-3333-4333-8333-333333333333';
set local role authenticated;
select public.respond_my_visit_backup('a6666666-6666-4666-8666-666666666662',
 (select id from public.client_visit_assignments where job_id='a6666666-6666-4666-8666-666666666662'),
 'a4444444-4444-4444-8444-444444444444','a3333333-3333-4333-8333-333333333333',
 'b4444444-4444-4444-8444-444444444444',true,'Preview approval',null);
reset role;
set local request.jwt.claim.sub='b2222222-2222-4222-8222-222222222222';
do $verify$ begin
 if not public.start_job('a6666666-6666-4666-8666-666666666662','a3333333-3333-4333-8333-333333333333') then
  raise exception 'Approved preview backup could not start'; end if;
 raise notice 'Preview setup: catalog, guards, fixtures, role reads and exact backup approval passed';
end $verify$;
rollback;
`);
