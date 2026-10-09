-- Cleaner receipts contain their own terms. Management keeps the saved client
-- price for review. Existing ownership checks, grants and write guards remain.
create or replace function spotless_private.crew_public_receipt(p_id uuid) returns jsonb
language sql stable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',q.id,'jobId',q.job_id,'cleanerName',q.candidate_snapshot->'full_name','type',q.candidate_type,
 'payoutCents',q.payout_cents,'hourlyRateCents',q.candidate_snapshot->'hourly_rate_cents',
 'start',q.snapshot->'visit'->'start','minutes',q.snapshot->'visit'->'minutes',
 'expiresAt',q.expires_at,
 'state',case when q.state in ('review','sent') and q.snapshot is distinct from spotless_private.crew_snapshot(q.job_id) then 'withdrawn'
 when q.state in ('review','sent') and q.expires_at<=clock_timestamp() then 'expired' else q.state end,
 'assignmentId',case when q.state='accepted' then q.assignment_key else null end,
 'assignmentCurrent',q.state='accepted' and exists(select 1 from job_assignments a join jobs j on j.id=a.job_id where a.id=q.assignment_key and a.job_id=q.job_id and a.cleaner_id=q.cleaner_id and j.status not in ('complete','canceled')),
 'clientApproved',q.state='accepted' and exists(select 1 from jobs j join job_assignments a on a.job_id=j.id and a.id=q.assignment_key and a.cleaner_id=q.cleaner_id where j.id=q.job_id
 and (j.preferred_cleaner_id is null or j.preferred_cleaner_id=a.cleaner_id or coalesce((select d.accepted from visit_backup_decisions d where d.job_id=j.id and d.assignment_id=a.id and d.customer_id=j.customer_id and d.decided_by=(select profile_id from customers where id=j.customer_id) and d.preferred_cleaner_id=j.preferred_cleaner_id and d.backup_cleaner_id=a.cleaner_id order by d.version desc limit 1),false))),
 'needsClientApproval',q.cleaner_id is distinct from (q.snapshot->'visit'->>'preferred')::uuid,
 'city',q.snapshot->'visit'->'property'->'city')
 || case when public.is_admin() then
 jsonb_build_object('clientPriceCents',q.snapshot->'visit'->'price')
 else '{}'::jsonb end
 from spotless_private.crew_lead_proposals q join cleaners c on c.id=q.cleaner_id
 join properties p on p.id=(q.snapshot->'visit'->>'property_id')::uuid where q.id=p_id
$$;
