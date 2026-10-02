-- A sweep may have loaded a plan before a client changes it. Locking the
-- current row is insufficient unless the sweep also proves which version it
-- read. Generation bookkeeping deliberately does not change that version.
alter table public.recurring_plans
  add column schedule_revision bigint not null default 1
    check (schedule_revision > 0);

create function public.bump_recurring_schedule_revision()
returns trigger language plpgsql set search_path = public as $$
begin
  if row(new.customer_id,new.property_id,new.service,new.freq,new.anchor_date,
         new.start_time,new.ends_on,new.paused_until,new.active,new.horizon_days,
         new.agreed_price_cents,new.estimated_minutes,new.notes,
         new.preferred_cleaner_id,new.agreed_payout_share)
     is distinct from
     row(old.customer_id,old.property_id,old.service,old.freq,old.anchor_date,
         old.start_time,old.ends_on,old.paused_until,old.active,old.horizon_days,
         old.agreed_price_cents,old.estimated_minutes,old.notes,
         old.preferred_cleaner_id,old.agreed_payout_share) then
    new.schedule_revision := old.schedule_revision + 1;
  else
    new.schedule_revision := old.schedule_revision;
  end if;
  return new;
end $$;
revoke all on function public.bump_recurring_schedule_revision() from public,anon,authenticated;
create trigger recurring_plans_schedule_revision before update on public.recurring_plans
for each row execute function public.bump_recurring_schedule_revision();

-- Match the pure schedule engine: monthly means the anchor's nth weekday,
-- with a fifth weekday clamped to the last one present in a shorter month.
create function public.recurring_date_matches(p_freq public.frequency,p_anchor date,p_date date)
returns boolean language plpgsql immutable set search_path = public as $$
declare v_first date; v_last date; v_candidate date;
begin
  if p_anchor is null or p_date is null or not isfinite(p_anchor)
     or not isfinite(p_date) or p_date < p_anchor then return false; end if;
  if p_freq = 'one_time' then return p_date = p_anchor; end if;
  if p_freq = 'weekly' then return (p_date-p_anchor)%7 = 0; end if;
  if p_freq = 'biweekly' then return (p_date-p_anchor)%14 = 0; end if;
  if p_freq is distinct from 'monthly'::public.frequency then return false; end if;
  v_first := date_trunc('month',p_date::timestamp)::date;
  v_last := (v_first + interval '1 month' - interval '1 day')::date;
  v_candidate := v_first + ((extract(dow from p_anchor)::integer
                   - extract(dow from v_first)::integer + 7)%7)
                 + 7*((extract(day from p_anchor)::integer-1)/7);
  if v_candidate > v_last then v_candidate := v_candidate-7; end if;
  return p_date = v_candidate;
end $$;
revoke all on function public.recurring_date_matches(public.frequency,date,date) from public,anon,authenticated;

-- Keep SQL and the generator's Dallas clock rules identical. Use the first
-- repeated autumn hour; a missing spring time moves to the first real minute.
create function public.recurring_start_at(p_date date,p_time time)
returns timestamptz language plpgsql stable set search_path = public as $$
declare v_local timestamp; v_guess timestamptz; v_result timestamptz;
begin
  if p_date is null or not isfinite(p_date) or p_time is null
     or p_time >= time '24:00' or extract(second from p_time) <> 0 then
    raise exception 'invalid recurring date or time' using errcode='22023';
  end if;
  v_local := p_date+p_time;
  v_guess := v_local at time zone 'America/Chicago';
  if v_guess at time zone 'America/Chicago' = v_local then
    if (v_guess-interval '1 hour') at time zone 'America/Chicago' = v_local then
      return v_guess-interval '1 hour';
    end if;
    return v_guess;
  end if;
  select min(t) into v_result
    from generate_series(v_guess-interval '2 hours',v_guess+interval '2 hours',interval '1 minute') t
    where t at time zone 'America/Chicago' >= v_local
      and (t at time zone 'America/Chicago')::date = p_date;
  if v_result is null then
    raise exception 'unresolvable recurring time' using errcode='22023';
  end if;
  return v_result;
end $$;
revoke all on function public.recurring_start_at(date,time) from public,anon,authenticated;

-- Compatibility for an older deployed generator: derive new appointments
-- from the locked current plan, never from its stale supplied timestamp.
-- Existing occurrence identities remain stable across individual reschedules.
create or replace function public.materialise_recurring_job(
  p_plan_id uuid,p_occurrence_date date,p_scheduled_start timestamptz
) returns table(job_id uuid,created boolean)
language plpgsql security definer set search_path = public as $$
declare v_plan public.recurring_plans%rowtype; v_job_id uuid; v_start timestamptz;
begin
  select * into v_plan from public.recurring_plans where id=p_plan_id for update;
  if v_plan.id is null then raise exception 'recurring plan not found' using errcode='22023'; end if;
  if not v_plan.active then raise exception 'recurring plan is not active' using errcode='40001'; end if;
  if p_occurrence_date is null or not isfinite(p_occurrence_date) then
    raise exception 'invalid occurrence date' using errcode='22023';
  end if;
  if exists(select 1 from public.recurring_plan_skips
            where plan_id=p_plan_id and occurrence_date=p_occurrence_date) then
    return query select null::uuid,false; return;
  end if;
  select j.id into v_job_id from public.jobs j
    where j.recurring_plan_id=p_plan_id and j.occurrence_date=p_occurrence_date;
  if v_job_id is not null then return query select v_job_id,false; return; end if;
  if not public.recurring_date_matches(v_plan.freq,v_plan.anchor_date,p_occurrence_date)
     or (v_plan.ends_on is not null and p_occurrence_date > v_plan.ends_on)
     or (v_plan.paused_until is not null and p_occurrence_date <= v_plan.paused_until) then
    return query select null::uuid,false; return;
  end if;
  v_start := public.recurring_start_at(p_occurrence_date,v_plan.start_time);
  insert into public.jobs(
    customer_id,property_id,recurring_plan_id,occurrence_date,status,service,freq,
    scheduled_start,price_cents,estimated_clean_minutes,notes,preferred_cleaner_id,agreed_payout_share
  ) values (
    v_plan.customer_id,v_plan.property_id,p_plan_id,p_occurrence_date,'scheduled',v_plan.service,v_plan.freq,
    v_start,v_plan.agreed_price_cents,v_plan.estimated_minutes,v_plan.notes,
    v_plan.preferred_cleaner_id,v_plan.agreed_payout_share
  ) on conflict (recurring_plan_id,occurrence_date)
      where recurring_plan_id is not null and occurrence_date is not null
    do nothing returning id into v_job_id;
  if v_job_id is null then
    select j.id into v_job_id from public.jobs j
      where j.recurring_plan_id=p_plan_id and j.occurrence_date=p_occurrence_date;
    return query select v_job_id,false; return;
  end if;
  update public.recurring_plans set last_generated_at=now(),
    next_job_date=least(coalesce(next_job_date,p_occurrence_date),p_occurrence_date)
    where id=p_plan_id;
  return query select v_job_id,true;
end $$;
revoke all on function public.materialise_recurring_job(uuid,date,timestamptz) from public,anon,authenticated;
grant execute on function public.materialise_recurring_job(uuid,date,timestamptz) to service_role;

create function public.materialise_recurring_job_for_revision(
  p_plan_id uuid,p_occurrence_date date,p_scheduled_start timestamptz,p_schedule_revision bigint
) returns table(job_id uuid,created boolean)
language plpgsql security definer set search_path = public as $$
declare v_plan public.recurring_plans%rowtype;
begin
  select * into v_plan from public.recurring_plans where id=p_plan_id for update;
  if v_plan.id is null then raise exception 'recurring plan not found' using errcode='22023'; end if;
  if p_schedule_revision is null or p_schedule_revision <> v_plan.schedule_revision then
    raise exception 'recurring plan changed; reload before generating' using errcode='40001';
  end if;
  if p_scheduled_start is null or not isfinite(p_scheduled_start)
     or p_scheduled_start is distinct from public.recurring_start_at(p_occurrence_date,v_plan.start_time) then
    raise exception 'recurring start does not match the current plan' using errcode='22023';
  end if;
  return query select * from public.materialise_recurring_job(p_plan_id,p_occurrence_date,p_scheduled_start);
end $$;
revoke all on function public.materialise_recurring_job_for_revision(uuid,date,timestamptz,bigint) from public,anon,authenticated;
grant execute on function public.materialise_recurring_job_for_revision(uuid,date,timestamptz,bigint) to service_role;
