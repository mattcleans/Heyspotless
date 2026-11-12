-- The versioned upload path never overwrites an object. Preserve updates to
-- old canonical paths for clients still finishing a legacy upload.
do $$
begin
  if to_regclass('storage.objects') is null
     or to_regprocedure('storage.foldername(text)') is null then
    return;
  end if;

  create policy job_photo_updates_legacy_only
    on storage.objects as restrictive for update
    using (
      bucket_id is distinct from 'job-photos'
      or (split_part(name, '/', 1) = 'jobs' and cardinality(storage.foldername(name)) = 2)
    )
    with check (
      bucket_id is distinct from 'job-photos'
      or (split_part(name, '/', 1) = 'jobs' and cardinality(storage.foldername(name)) = 2)
    );
end $$;
