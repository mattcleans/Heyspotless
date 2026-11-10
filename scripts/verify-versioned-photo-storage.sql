-- Disposable database only. The Storage API metadata table is simulated.
begin;
create schema if not exists storage;
create function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/'))-1]
$$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update on storage.objects to authenticated;
create policy synthetic_photo_read on storage.objects for select using (true);
create policy synthetic_photo_insert on storage.objects for insert with check (true);
create policy synthetic_photo_update on storage.objects for update using (true);
\ir ../supabase/migrations/20261110223923_protect_versioned_photo_objects.sql
set local role authenticated;
do $$
declare
  legacy text := 'jobs/11111111-1111-4111-8111-111111111111/kitchen_1-before.jpg';
  versioned text := 'jobs/11111111-1111-4111-8111-111111111111/kitchen_1-before/22222222-2222-4222-8222-222222222222.jpg';
begin
  insert into storage.objects(bucket_id,name) values
    ('job-photos',legacy), ('job-photos',versioned),
    ('cleaner-photos','profiles/synthetic/avatar.jpg');

  update storage.objects set name=name where bucket_id='job-photos' and name=versioned;
  if found then raise exception 'Versioned photo permitted an update'; end if;

  update storage.objects set name=name where bucket_id='job-photos' and name=legacy;
  if not found then raise exception 'Legacy update failed'; end if;

  begin
    update storage.objects set name=versioned||'.new' where bucket_id='job-photos' and name=legacy;
    raise exception 'Update permitted moving a legacy object to a versioned path';
  exception when insufficient_privilege then null;
  end;

  update storage.objects set name=name where bucket_id='cleaner-photos';
  if not found then raise exception 'Profile photo update failed'; end if;
  raise notice 'Versioned photo insert passes, updates are denied, legacy and profile updates still pass';
end $$;
rollback;
