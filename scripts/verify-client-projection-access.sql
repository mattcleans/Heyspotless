-- No real identities or rows; the entire fixture rolls back.
begin;
do $$
declare
  v_cleaner uuid;
  v_name text;
  v_privilege text;
  v_count integer;
begin
  foreach v_name in array array['cleaner_profiles','cleaner_reviews','client_visit_assignments','visit_backup_status'] loop
    if not has_table_privilege('authenticated','public.'||v_name,'SELECT')
       or not has_table_privilege('service_role','public.'||v_name,'SELECT')
       or has_table_privilege('anon','public.'||v_name,'SELECT') then
      raise exception 'Projection read grants changed: %',v_name;
    end if;
    foreach v_privilege in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('authenticated','public.'||v_name,v_privilege)
         or has_table_privilege('anon','public.'||v_name,v_privilege) then
        raise exception 'Unexpected % privilege on %',v_privilege,v_name;
      end if;
    end loop;
  end loop;

  insert into public.cleaners(full_name,type,status,rating,background_check_cleared,profile_published,bio)
    values('SYNTHETIC Projection Test','contractor_1099','active',4.8,true,true,'original synthetic bio') returning id into v_cleaner;
  -- No Cleaner identity: an ordinary signed-in user can browse published
  -- profiles, but cannot rewrite one through the definer view.
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.cleaner_profiles where id=v_cleaner;
  if v_count<>1 then raise exception 'Published profile is no longer readable'; end if;
  begin
    update public.cleaner_profiles set bio='unauthorized rewrite' where id=v_cleaner;
    raise exception 'Signed-in user can still edit a published profile';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.cleaner_profiles where id=v_cleaner;
    raise exception 'Signed-in user can still delete a published profile';
  exception when insufficient_privilege then null;
  end;
  foreach v_name in array array['cleaner_reviews','client_visit_assignments','visit_backup_status'] loop
    execute format('select count(*) from public.%I',v_name) into v_count;
  end loop;
  execute 'reset role';
  if not exists(select 1 from public.cleaners where id=v_cleaner and bio='original synthetic bio') then
    raise exception 'Profile data changed through the read model';
  end if;
end $$;
rollback;
