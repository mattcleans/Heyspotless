-- New capture objects are immutable by convention and independently verified.
-- Existing canonical photos retain explicit legacy semantics; no rows are rewritten.
alter table public.job_photos add column capture_revision uuid,
 add column object_id uuid, add column object_version text, add column content_sha256 text,
 add constraint photo_capture_identity_complete check (
  (capture_revision is null and object_id is null and object_version is null and content_sha256 is null) or
  (capture_revision is not null and object_id is not null and object_version is not null and object_version<>'' and content_sha256 is not null and content_sha256 ~ '^[a-f0-9]{64}$'));
revoke insert,update,delete on public.job_photos from public,anon,authenticated;
create table spotless_private.photo_capture_receipts (
 revision uuid primary key,job_id uuid not null references public.jobs(id),
 cleaner_id uuid not null references public.cleaners(id),room_key text not null,kind text not null,
 photo_id uuid not null,storage_path text not null,object_id uuid not null,
 object_version text not null,content_sha256 text not null,byte_size bigint not null check(byte_size>0),
 supersedes uuid[] not null,recorded_at timestamptz not null default clock_timestamp()
);
alter table spotless_private.photo_capture_receipts enable row level security;
revoke all on spotless_private.photo_capture_receipts from public,anon,authenticated,service_role;

create function spotless_private.assert_photo_capture_slot(p_job uuid,p_cleaner uuid,p_room text,p_kind text,p_revision uuid,p_path text)
returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype;s public.job_room_scopes%rowtype;keys text[];
begin
 select * into j from public.jobs where id=p_job;
 if j.id is null or j.status not in ('assigned','in_progress','complete') or not exists(select 1 from public.job_assignments where job_id=j.id and cleaner_id=p_cleaner) then raise insufficient_privilege;end if;
 if not exists(select 1 from public.properties where id=j.property_id and customer_id=j.customer_id) then raise invalid_parameter_value;end if;
 select * into s from public.job_room_scopes where job_id=j.id and customer_id=j.customer_id and property_id=j.property_id;
 if s.job_id is null then raise invalid_parameter_value;end if;
 keys:=spotless_private.required_photo_keys(s.bedrooms,s.bathrooms,s.half_baths,s.kitchens,s.living_rooms,s.utility_rooms);
 if p_revision is null or p_room is null or not(p_room=any(keys)) or p_kind is null or p_kind not in ('before','after','issue') or p_path is distinct from 'jobs/'||j.id||'/'||p_room||'-'||p_kind||'/'||p_revision||'.jpg' then raise invalid_parameter_value;end if;
end $$;
revoke all on function spotless_private.assert_photo_capture_slot(uuid,uuid,text,text,uuid,text) from public,anon,authenticated,service_role;

create function public.job_photo_upload_candidate(p_job uuid,p_cleaner uuid,p_path text,p_room text,p_kind text,p_revision uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare candidate jsonb;
begin
 perform spotless_private.assert_photo_capture_slot(p_job,p_cleaner,p_room,p_kind,p_revision,p_path);
 select jsonb_build_object('objectId',o.id,'objectVersion',to_jsonb(o)->>'version','byteSize',(o.metadata->>'size')::bigint) into candidate
 from storage.objects o where bucket_id='job-photos' and name=p_path and archived_at is null and not coalesce(is_delete_marker,false)
  and nullif(to_jsonb(o)->>'version','') is not null and (o.metadata->>'size') ~ '^[0-9]{1,18}$';
 if candidate is null or (candidate->>'byteSize')::bigint<=0 then raise exception 'Uploaded object is not available' using errcode='PPH01';end if;
 return candidate;
end $$;
revoke all on function public.job_photo_upload_candidate(uuid,uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.job_photo_upload_candidate(uuid,uuid,text,text,text,uuid) to service_role;

create function spotless_private.photo_object_matches(p public.job_photos)
returns boolean language plpgsql stable set search_path=pg_catalog,pg_temp as $$
begin
 return exists(select 1 from storage.objects o where o.bucket_id='job-photos' and o.name=p.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false) and (
  (p.capture_revision is null and p.storage_path='jobs/'||p.job_id||'/'||p.room_key||'-'||p.kind||'.jpg') or
  (p.capture_revision is not null and o.id=p.object_id and to_jsonb(o)->>'version'=p.object_version
   and p.storage_path='jobs/'||p.job_id||'/'||p.room_key||'-'||p.kind||'/'||p.capture_revision||'.jpg'
   and exists(select 1 from spotless_private.photo_capture_receipts r where r.revision=p.capture_revision and r.job_id=p.job_id and r.photo_id=p.id and r.storage_path=p.storage_path and r.object_id=p.object_id and r.object_version=p.object_version and r.content_sha256=p.content_sha256))
 ));
end $$;
revoke all on function spotless_private.photo_object_matches(public.job_photos) from public,anon,authenticated,service_role;

create function public.record_job_photo_capture(p_job uuid,p_cleaner uuid,p_path text,p_room text,p_kind text,p_revision uuid,p_sha256 text,p_supersedes uuid[],p_object uuid,p_object_version text,p_byte_size bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare old public.job_photos%rowtype;r spotless_private.photo_capture_receipts%rowtype;photo uuid;
begin
 -- The visit lock serializes assignment changes and every photo slot change.
 perform 1 from public.jobs where id=p_job for update;
 perform spotless_private.assert_photo_capture_slot(p_job,p_cleaner,p_room,p_kind,p_revision,p_path);
 if p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' or p_supersedes is null or cardinality(p_supersedes)>64 or array_position(p_supersedes,null) is not null or p_revision=any(p_supersedes) or cardinality(p_supersedes)<>(select count(distinct n) from unnest(p_supersedes)n) or p_byte_size is null or p_byte_size<=0 then raise invalid_parameter_value;end if;
 -- Recheck the exact identity observed before streaming/hash verification.
 perform 1 from storage.objects o where o.id=p_object and o.bucket_id='job-photos' and o.name=p_path and o.archived_at is null and not coalesce(o.is_delete_marker,false) and to_jsonb(o)->>'version'=p_object_version and o.metadata->>'size'=p_byte_size::text for share;
 if not found then raise exception 'Object changed during verification' using errcode='PPH01';end if;
 select * into r from spotless_private.photo_capture_receipts where revision=p_revision;
 if r.revision is not null then
  if r.job_id is distinct from p_job or r.cleaner_id is distinct from p_cleaner or r.storage_path is distinct from p_path or r.content_sha256 is distinct from p_sha256 or r.object_id is distinct from p_object or r.object_version is distinct from p_object_version or r.byte_size is distinct from p_byte_size or r.supersedes is distinct from p_supersedes then raise exception 'Capture identity already used' using errcode='PPH01';end if;
 else
  select * into old from public.job_photos where job_id=p_job and room_key=p_room and kind=p_kind order by taken_at,id limit 1 for update;
  if old.capture_revision is not null and not(old.capture_revision=any(p_supersedes)) then raise exception 'Another capture is current; keep the local copy' using errcode='PPH01';end if;
  if old.id is null then
   insert into public.job_photos(job_id,cleaner_id,storage_path,kind,room_key,capture_revision,object_id,object_version,content_sha256)
    values(p_job,p_cleaner,p_path,p_kind,p_room,p_revision,p_object,p_object_version,p_sha256) returning id into photo;
  else
   update public.job_photos set cleaner_id=p_cleaner,storage_path=p_path,capture_revision=p_revision,object_id=p_object,object_version=p_object_version,content_sha256=p_sha256,taken_at=clock_timestamp() where id=old.id returning id into photo;
  end if;
  insert into spotless_private.photo_capture_receipts(revision,job_id,cleaner_id,room_key,kind,photo_id,storage_path,object_id,object_version,content_sha256,byte_size,supersedes)
   values(p_revision,p_job,p_cleaner,p_room,p_kind,photo,p_path,p_object,p_object_version,p_sha256,p_byte_size,p_supersedes) returning * into r;
  perform public.settle_job_invoice(p_job);
 end if;
 -- An accepted older replay returns its own receipt without changing the current slot.
 return jsonb_build_object('recorded',true,'jobId',r.job_id,'roomKey',r.room_key,'kind',r.kind,'storagePath',r.storage_path,'revision',r.revision,'sha256',r.content_sha256,'supersedes',to_jsonb(r.supersedes),'photoId',r.photo_id,'objectId',r.object_id,'objectVersion',r.object_version);
end $$;
revoke all on function public.record_job_photo_capture(uuid,uuid,text,text,text,uuid,text,uuid[],uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.record_job_photo_capture(uuid,uuid,text,text,text,uuid,text,uuid[],uuid,text,bigint) to service_role;
-- Old servers may keep bytes queued during rollout, but cannot replace versioned slots.
revoke execute on function public.record_job_photo(uuid,uuid,text,text,text) from service_role;

create function public.verified_job_photos(p_job uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 return coalesce((select jsonb_agg(jsonb_build_object('room_key',p.room_key,'kind',p.kind,'revision',p.capture_revision) order by p.taken_at,p.id) from public.job_photos p where p.job_id=p_job and spotless_private.photo_object_matches(p)),'[]'::jsonb);
end $$;
revoke all on function public.verified_job_photos(uuid) from public,anon,authenticated;
grant execute on function public.verified_job_photos(uuid) to service_role;

create or replace function public.settle_job_invoice(p_job_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 j public.jobs%rowtype; h public.properties%rowtype; s public.job_room_scopes%rowtype; i public.invoices%rowtype;
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
 select * into s from public.job_room_scopes where job_id=j.id and customer_id=j.customer_id and property_id=j.property_id for share;
 if s.job_id is null then return null;end if;
 begin
  keys:=spotless_private.required_photo_keys(s.bedrooms,s.bathrooms,s.half_baths,s.kitchens,s.living_rooms,s.utility_rooms);
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
    and spotless_private.photo_object_matches(p))
 ) then return null; end if;
 insert into public.invoices(job_id,customer_id,kind,status,subtotal_cents,total_cents)
 values(j.id,j.customer_id,'service','draft',j.price_cents,j.price_cents) returning id into i.id;
 update public.jobs set invoiced_at=clock_timestamp() where id=j.id;
 return i.id;
end $$;
revoke all on function public.settle_job_invoice(uuid) from public,anon,authenticated;
grant execute on function public.settle_job_invoice(uuid) to service_role;


create or replace function public.issue_reviewed_service_invoice(
 p_job uuid,p_invoice uuid,p_actor uuid,p_reviewed_total integer,p_due date
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype;i public.invoices%rowtype;s public.job_room_scopes%rowtype;
 r spotless_private.service_invoice_issuances%rowtype;keys text[];v_issued_at timestamptz;
begin
 if p_job is null or p_invoice is null or p_actor is null or p_reviewed_total is null or p_reviewed_total<0 or p_due is null or not isfinite(p_due) then raise invalid_parameter_value;end if;
 perform 1 from public.profiles where id=p_actor and role='admin' for share;
 if not found then raise insufficient_privilege;end if;
 -- Same ordering as draft preparation, photo recording and settlement.
 select * into j from public.jobs where id=p_job for update;
 select * into i from public.invoices where id=p_invoice for update;
 if j.id is null or i.id is null or i.job_id is distinct from j.id or i.customer_id is distinct from j.customer_id or i.kind<>'service' or i.voided_at is not null or i.status='void' then
  raise exception 'Review the saved service invoice' using errcode='PIS01';
 end if;
 select * into r from spotless_private.service_invoice_issuances where invoice_id=i.id;
 if r.invoice_id is not null then
  if i.status not in ('sent','paid','overdue') or r.job_id is distinct from j.id or r.customer_id is distinct from j.customer_id or r.property_id is distinct from j.property_id or r.total_cents is distinct from p_reviewed_total or r.due_on is distinct from p_due or i.issued_at is distinct from r.issued_at or i.due_on is distinct from r.due_on then
   raise exception 'The invoice review changed' using errcode='PIS01';
  end if;
 else
  if p_due<(clock_timestamp() at time zone 'America/Chicago')::date or j.status<>'complete' or i.status<>'draft' or i.issued_at is not null or i.total_cents is distinct from p_reviewed_total or i.subtotal_cents is distinct from j.price_cents or i.total_cents is distinct from i.subtotal_cents or i.tip_cents<>0 or i.amount_paid_cents<>0 or i.refunded_cents<>0 or i.credit_cents<>0 or i.stripe_checkout_session_id is not null
   or (select count(*) from public.invoices where job_id=j.id and kind='service')<>1
   or exists(select 1 from public.payments where invoice_id=i.id)
   or exists(select 1 from public.payment_operations where invoice_id=i.id and state in ('open','abandoned')) then
   raise exception 'The invoice review changed' using errcode='PIS01';
  end if;
  perform 1 from public.properties where id=j.property_id and customer_id=j.customer_id for share;
  if not found then raise exception 'Review visit ownership' using errcode='PIS01';end if;
  select * into s from public.job_room_scopes where job_id=j.id and customer_id=j.customer_id and property_id=j.property_id for share;
  if s.job_id is null then raise exception 'Review the saved room list' using errcode='PIS01';end if;
  keys:=spotless_private.required_photo_keys(s.bedrooms,s.bathrooms,s.half_baths,s.kitchens,s.living_rooms,s.utility_rooms);
  perform 1 from storage.objects o join public.job_photos ph on o.bucket_id='job-photos' and o.name=ph.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
   where ph.job_id=j.id and ph.room_key=any(keys) and ph.kind in ('before','after') order by o.id for share of o;
  if exists(select 1 from unnest(keys) room cross join (values('before'),('after')) kind(k)
   where not exists(select 1 from public.job_photos ph join storage.objects o on o.bucket_id='job-photos' and o.name=ph.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
    where ph.job_id=j.id and ph.room_key=room and ph.kind=kind.k and spotless_private.photo_object_matches(ph))) then
   raise exception 'Review the saved photo evidence' using errcode='PIS01';
  end if;
  v_issued_at:=clock_timestamp();
  update public.invoices set status='sent',issued_at=v_issued_at,due_on=p_due,next_attempt_at=null where id=i.id;
  update public.jobs set invoiced_at=coalesce(invoiced_at,v_issued_at) where id=j.id;
  insert into spotless_private.service_invoice_issuances(invoice_id,job_id,customer_id,property_id,issued_by,total_cents,due_on,issued_at)
   values(i.id,j.id,j.customer_id,j.property_id,p_actor,i.total_cents,p_due,v_issued_at) returning * into r;
 end if;
 return jsonb_build_object('issued',true,'visitId',r.job_id,'invoiceId',r.invoice_id,'totalCents',r.total_cents,'dueOn',r.due_on,'issuedAt',r.issued_at);
end $$;
revoke all on function public.issue_reviewed_service_invoice(uuid,uuid,uuid,integer,date) from public,anon,authenticated;
grant execute on function public.issue_reviewed_service_invoice(uuid,uuid,uuid,integer,date) to service_role;
