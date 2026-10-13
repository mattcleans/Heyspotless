begin;
do $$ begin
 if recurring_start_at('2026-03-08','02:30')<>'2026-03-08T08:00Z'::timestamptz or
    recurring_start_at('2026-11-01','01:30')<>'2026-11-01T06:30Z'::timestamptz then raise exception 'DST parity broken';end if;
 if not recurring_date_matches('monthly','2026-09-29','2027-02-23') or
    recurring_date_matches('monthly','2026-09-29','2027-02-22') or
    recurring_date_matches('weekly','2026-09-15','2026-09-23') or
    not recurring_date_matches('biweekly','2026-09-15','2026-09-29') then raise exception 'cadence mismatch';end if;
 begin perform recurring_start_at('2026-09-15','24:00');raise exception 'invalid time accepted';exception when invalid_parameter_value then null;end;
end $$;
insert into auth.users(id,email) values('b1000000-0000-0000-0000-000000000001','generation@example.test');
insert into customers(id,profile_id,first_name,last_name) values('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Generation','Sample');
insert into properties(id,customer_id,street,city,zip) values('b3000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001','Sample','Dallas','75001');
insert into recurring_plans(id,customer_id,property_id,service,freq,agreed_price_cents,estimated_minutes,anchor_date,start_time,agreed_payout_share) values
 ('b9000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-000000000001','standard','weekly',20000,90,'2026-09-15','09:30',.45);
do $$ declare p uuid:='b9000000-0000-0000-0000-000000000001';r record;v_job uuid;begin
 select * into r from materialise_recurring_job_for_revision(p,'2026-09-15','2026-09-15T14:30Z',1);
 if not r.created or r.job_id is null then raise exception 'current revision not generated';end if;
 v_job:=r.job_id;
 if (select schedule_revision from recurring_plans where id=p)<>1 then raise exception 'bookkeeping advanced revision';end if;
 update jobs set scheduled_start='2026-09-16T14:30Z' where id=v_job;
 select * into r from materialise_recurring_job_for_revision(p,'2026-09-15','2026-09-15T14:30Z',1);
 if r.created or r.job_id<>v_job then raise exception 'individual move regenerated original slot';end if;
 update recurring_plans set start_time='10:30' where id=p;
 if (select schedule_revision from recurring_plans where id=p)<>2 then raise exception 'edit did not advance revision';end if;
 begin perform materialise_recurring_job_for_revision(p,'2026-09-22','2026-09-22T14:30Z',1);
  raise exception 'stale sweep generated';exception when sqlstate 'PT409' then null;end;
 begin perform materialise_recurring_job_for_revision(p,'2026-09-22','2026-09-22T14:30Z',2);
  raise exception 'wrong clock generated';exception when invalid_parameter_value then null;end;
 -- An old deployed caller also gets the locked plan's authoritative time.
 select * into r from materialise_recurring_job(p,'2026-09-22','2026-09-22T14:30Z');
 if not r.created or not exists(select 1 from jobs where id=r.job_id and scheduled_start='2026-09-22T15:30Z' and price_cents=20000 and agreed_payout_share=.45) then raise exception 'legacy sweep used stale settings';end if;
 update recurring_plans set paused_until='2026-09-29',ends_on='2026-10-06' where id=p;
 select * into r from materialise_recurring_job(p,'2026-09-29','2026-09-29T15:30Z');
 if r.job_id is not null then raise exception 'pause ignored';end if;
 select * into r from materialise_recurring_job(p,'2026-10-13','2026-10-13T15:30Z');
 if r.job_id is not null then raise exception 'end ignored';end if;
 select * into r from materialise_recurring_job(p,'2026-10-07','2026-10-07T15:30Z');
 if r.job_id is not null then raise exception 'cadence ignored';end if;
 insert into recurring_plan_skips(plan_id,occurrence_date) values(p,'2026-10-06');
 select * into r from materialise_recurring_job(p,'2026-10-06','2026-10-06T15:30Z');
 if r.job_id is not null then raise exception 'skip ignored';end if;
 update recurring_plans set schedule_revision=1,last_generated_at=now(),next_job_date='2026-10-06' where id=p;
 if (select schedule_revision from recurring_plans where id=p)<>3 then raise exception 'revision rewound or bookkeeping changed it';end if;
 if (select count(*) from jobs where recurring_plan_id=p)<>2 then raise exception 'rejected generation left visits';end if;
 if has_function_privilege('authenticated','materialise_recurring_job_for_revision(uuid,date,timestamptz,bigint)','EXECUTE') or
    has_function_privilege('anon','materialise_recurring_job_for_revision(uuid,date,timestamptz,bigint)','EXECUTE') then raise exception 'generation callable by client';end if;
end $$;
rollback;
