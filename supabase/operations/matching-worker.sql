-- Hosted Supabase operator setup, after deploying and validating the worker.
-- The project URL is supplied as spotless.matching_worker_url. No key belongs
-- in this script, its migration history or cron command text.
create extension if not exists pg_cron;
-- A private synchronous transport keeps credential-bearing requests out of
-- pg_net's admin-owned queue tables. Cron waits for the bounded worker result.
create extension if not exists http with schema spotless_private;
create table spotless_private.matching_worker_destination (
  id boolean primary key default true check(id),
  project_url text not null check(project_url ~ '^https://[a-z0-9]{20}\.supabase\.co$')
);
alter table spotless_private.matching_worker_destination enable row level security;
revoke all on spotless_private.matching_worker_destination from public,anon,authenticated,service_role;
insert into spotless_private.matching_worker_destination(id,project_url)
 values(true,current_setting('spotless.matching_worker_url'));

create function public.configure_matching_worker_credentials(p_project_url text,p_anon_key text,p_token text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_project_url !~ '^https://[a-z0-9]{20}\.supabase\.co$' or p_project_url is null
 or p_anon_key is null or p_anon_key not like 'eyJ%' or char_length(p_anon_key)>2000
 or p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'invalid worker credentials' using errcode='22023';end if;
 if p_project_url is distinct from (select project_url from spotless_private.matching_worker_destination where id for update) then raise exception 'configured project required' using errcode='42501';end if;
 if exists(select 1 from vault.secrets where name in ('heyspotless_matching_project_url','heyspotless_matching_anon_key','heyspotless_matching_worker_token')) then
   raise exception 'worker credentials already configured; review rotation separately' using errcode='PT409';
 end if;
 perform vault.create_secret(p_project_url,'heyspotless_matching_project_url');
 perform vault.create_secret(p_anon_key,'heyspotless_matching_anon_key');
 perform vault.create_secret(p_token,'heyspotless_matching_worker_token');
 perform public.configure_matching_worker_token(p_token);
 return true;
end $$;
revoke all on function public.configure_matching_worker_credentials(text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.configure_matching_worker_credentials(text,text,text) to service_role;

create or replace function spotless_private.invoke_matching_worker() returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_url text;v_anon text;v_token text;v_status integer;
begin
 select decrypted_secret into v_url from vault.decrypted_secrets where name='heyspotless_matching_project_url';
 select decrypted_secret into v_anon from vault.decrypted_secrets where name='heyspotless_matching_anon_key';
 select decrypted_secret into v_token from vault.decrypted_secrets where name='heyspotless_matching_worker_token';
 if v_url is null or v_anon is null or v_token is null or v_url !~ '^https://[a-z0-9]{20}\.supabase\.co$'
 or v_url is distinct from (select project_url from spotless_private.matching_worker_destination where id) then raise exception 'worker configuration missing';end if;
 perform spotless_private.http_reset_curlopt();
 perform spotless_private.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','10000');
 perform spotless_private.http_set_curlopt('CURLOPT_TIMEOUT_MS','90000');
 select response.status into v_status from spotless_private.http((
  'POST',v_url||'/functions/v1/matching-worker',
  array[row('Authorization','Bearer '||v_anon)::spotless_private.http_header,
        row('apikey',v_anon)::spotless_private.http_header,
        row('x-heyspotless-worker-token',v_token)::spotless_private.http_header],
  'application/json','{}'
 )::spotless_private.http_request) response;
 if v_status is null or v_status not in (200,202) then raise exception 'Matching worker returned HTTP %',v_status;end if;
 return v_status;
end $$;
revoke all on function spotless_private.invoke_matching_worker() from public,anon,authenticated,service_role;
-- Scheduling is intentionally a separate operator step after the first actual
-- worker result. The statement contains no credential values:
-- select cron.schedule('heyspotless-matching-preview','*/5 * * * *',
--   'select spotless_private.invoke_matching_worker();');
