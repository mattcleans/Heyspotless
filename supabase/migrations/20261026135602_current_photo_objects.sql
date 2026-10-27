-- Only active Storage objects count as visit evidence. Archived versions and
-- delete markers do not confirm a photo. Storage tables remain provider-owned.
create or replace function public.settle_job_invoice(p_job_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 j public.jobs%rowtype; h public.properties%rowtype; i public.invoices%rowtype;
 keys text[]; ids uuid[];
begin
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null or j.status<>'complete' then return null; end if;
 -- A fee is not a service invoice. Never create a replacement for an existing
 -- service bill (including a deliberately voided bill) or an ambiguous record.
 perform 1 from public.invoices where job_id=j.id and kind='service' order by id for update;
 select array_agg(id order by created_at,id) into ids from public.invoices where job_id=j.id and kind='service';
 if cardinality(ids)>0 then
  if cardinality(ids)<>1 then return null; end if;
  select * into i from public.invoices where id=ids[1];
  if i.customer_id<>j.customer_id or i.voided_at is not null or i.status='void' then return null; end if;
  update public.jobs set invoiced_at=coalesce(invoiced_at,i.created_at) where id=j.id;
  return i.id;
 end if;
 if j.invoiced_at is not null or j.price_cents is null or j.price_cents<0 then return null; end if;
 select * into h from public.properties where id=j.property_id for share;
 if h.id is null or h.customer_id<>j.customer_id then return null; end if;
 begin
  keys:=spotless_private.required_photo_keys(h.bedrooms,h.bathrooms,h.half_baths,h.kitchens,h.living_rooms,h.utility_rooms);
 exception when invalid_parameter_value then return null; end;
 -- Count the exact before/after slots, backed by their exact private objects.
 -- Arbitrary room names, issue photos and metadata without bytes do not count.
 perform 1 from storage.objects o join public.job_photos p on o.bucket_id='job-photos' and o.name=p.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
 where p.job_id=j.id and p.room_key=any(keys) and p.kind in ('before','after') order by o.id for share of o;
 if exists(
  select 1 from unnest(keys) r cross join (values('before'),('after')) k(kind)
  where not exists(select 1 from public.job_photos p join storage.objects o
   on o.bucket_id='job-photos' and o.name=p.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
   where p.job_id=j.id and p.room_key=r and p.kind=k.kind
    and p.storage_path='jobs/'||j.id::text||'/'||r||'-'||k.kind||'.jpg')
 ) then return null; end if;
 insert into public.invoices(job_id,customer_id,kind,status,subtotal_cents,total_cents)
 values(j.id,j.customer_id,'service','draft',j.price_cents,j.price_cents) returning id into i.id;
 update public.jobs set invoiced_at=clock_timestamp() where id=j.id;
 return i.id;
end $$;
revoke all on function public.settle_job_invoice(uuid) from public,anon,authenticated;
grant execute on function public.settle_job_invoice(uuid) to service_role;

create or replace function public.record_job_photo(
 p_job_id uuid,p_cleaner_id uuid,p_storage_path text,p_kind text,p_room_key text
) returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype; h public.properties%rowtype; keys text[]; photo_id uuid;
begin
 -- Assignment changes also lock this visit. The receipt cannot race a release.
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null or j.status not in ('assigned','in_progress','complete') or
  not exists(select 1 from public.job_assignments where job_id=j.id and cleaner_id=p_cleaner_id) then
  raise insufficient_privilege using message='The photo cannot be recorded for this assignment.';
 end if;
 select * into h from public.properties where id=j.property_id for share;
 if h.id is null or h.customer_id<>j.customer_id then raise invalid_parameter_value; end if;
 keys:=spotless_private.required_photo_keys(h.bedrooms,h.bathrooms,h.half_baths,h.kitchens,h.living_rooms,h.utility_rooms);
 if p_kind is null or p_kind not in ('before','after','issue') or p_room_key is null or not(p_room_key=any(keys))
  or p_storage_path is distinct from 'jobs/'||j.id::text||'/'||p_room_key||'-'||p_kind||'.jpg' then
  raise invalid_parameter_value using message='The photo does not match a required visit slot.';
 end if;
 perform 1 from storage.objects where bucket_id='job-photos' and name=p_storage_path and archived_at is null and not coalesce(is_delete_marker,false) for share;
 if not found then raise exception using errcode='PPH01',message='The uploaded photo could not be confirmed.'; end if;
 if p_kind='issue' then
  select id into photo_id from public.job_photos where job_id=j.id and room_key=p_room_key and kind='issue' and storage_path=p_storage_path order by taken_at,id limit 1;
 end if;
 if photo_id is null then
 insert into public.job_photos(job_id,cleaner_id,storage_path,kind,room_key)
 values(j.id,p_cleaner_id,p_storage_path,p_kind,p_room_key)
 on conflict(job_id,room_key,kind) where room_key is not null and kind in ('before','after')
 do update set storage_path=excluded.storage_path,cleaner_id=excluded.cleaner_id,taken_at=clock_timestamp()
 where public.job_photos.storage_path is distinct from excluded.storage_path
 returning id into photo_id;
 end if;
 if photo_id is null then
  select id into photo_id from public.job_photos where job_id=j.id and room_key=p_room_key and kind=p_kind and storage_path=p_storage_path;
 end if;
 if photo_id is null then raise exception using errcode='PPH01',message='The saved photo slot needs review.'; end if;
 perform public.settle_job_invoice(j.id);
 return photo_id;
end $$;
revoke all on function public.record_job_photo(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.record_job_photo(uuid,uuid,text,text,text) to service_role;

