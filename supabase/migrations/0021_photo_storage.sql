-- ============================================================================
-- 0021 — somewhere for the photos to go
--
-- The bucket the cleaner PWA uploads to, and the policies that let her write
-- into it without letting her read anybody else's work.
--
-- GUARDED, because `storage` is a Supabase schema and the migration
-- verification script replays this chain against a bare PostgreSQL where it
-- does not exist. Skipping cleanly there is right: the bucket is infrastructure
-- rather than schema, and the SQL suites have nothing to say about it.
-- ============================================================================

do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice '0021: no storage schema (local verification) -- skipping bucket setup';
    return;
  end if;

  -- PRIVATE. A job photo is the inside of a customer's house; it is not
  -- something a guessed URL should return.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('job-photos', 'job-photos', false, 10485760,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  -- Paths are `jobs/<job_id>/<room>-<kind>.jpg`, so the second segment is the
  -- job and that is what every policy below checks against.
  execute $p$
    drop policy if exists job_photos_write_own on storage.objects;
    create policy job_photos_write_own on storage.objects for insert
      with check (
        bucket_id = 'job-photos'
        and exists (
          select 1 from job_assignments ja
          where ja.job_id = (storage.foldername(name))[2]::uuid
            and ja.cleaner_id = current_cleaner_id()
        )
      );

    -- Upsert: the queue retries with a derived path, so an ambiguous failure
    -- overwrites the same object rather than orphaning one.
    drop policy if exists job_photos_update_own on storage.objects;
    create policy job_photos_update_own on storage.objects for update
      using (
        bucket_id = 'job-photos'
        and exists (
          select 1 from job_assignments ja
          where ja.job_id = (storage.foldername(name))[2]::uuid
            and ja.cleaner_id = current_cleaner_id()
        )
      );

    -- She may look at what she took. Admins see everything; customers see
    -- nothing here, because the photo set is evidence for a dispute rather
    -- than a gallery, and handing it over unasked invites arguments about
    -- rooms nobody was asked to clean.
    drop policy if exists job_photos_read_own on storage.objects;
    create policy job_photos_read_own on storage.objects for select
      using (
        bucket_id = 'job-photos'
        and (
          is_admin()
          or exists (
            select 1 from job_assignments ja
            where ja.job_id = (storage.foldername(name))[2]::uuid
              and ja.cleaner_id = current_cleaner_id()
          )
        )
      );
  $p$;
end $$;
