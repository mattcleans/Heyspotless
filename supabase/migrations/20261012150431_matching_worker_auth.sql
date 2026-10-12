-- Worker authentication is independent of a runtime's injected API key string.
-- High-entropy tokens are hashed; only the operator's scheduler needs plaintext.
create table spotless_private.matching_worker_auth (
 id boolean primary key default true check(id),
 token_hash bytea not null check(octet_length(token_hash)=32)
);
alter table spotless_private.matching_worker_auth enable row level security;
revoke all on spotless_private.matching_worker_auth from public,anon,authenticated,service_role;

create function public.configure_matching_worker_token(p_token text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'invalid worker token' using errcode='22023';end if;
 insert into spotless_private.matching_worker_auth(id,token_hash)
 values(true,pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')))
 on conflict(id) do nothing;
 if not found then raise exception 'worker token already configured; review rotation separately' using errcode='PT409';end if;
 return true;
end $$;
revoke all on function public.configure_matching_worker_token(text) from public,anon,authenticated,service_role;
grant execute on function public.configure_matching_worker_token(text) to service_role;

create function public.verify_matching_worker_token(p_token text) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return false;end if;
 return coalesce((select token_hash=pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8'))
 from spotless_private.matching_worker_auth where id),false);
end $$;
revoke all on function public.verify_matching_worker_token(text) from public,anon,authenticated,service_role;
grant execute on function public.verify_matching_worker_token(text) to service_role;
