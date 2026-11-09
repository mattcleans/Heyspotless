begin;
do $$
declare
  customer_id uuid;
  property_id uuid;
  visit_id uuid;
  replay_id uuid;
  original_row jsonb;
begin
  insert into customers(first_name,last_name)
    values ('Synthetic','Import Replay') returning id into customer_id;
  insert into properties(customer_id,street,city,zip)
    values (customer_id,'Synthetic Import Way','Dallas','75201') returning id into property_id;

  visit_id := import_job('synthetic-replay-cutover',customer_id,property_id,'standard','weekly',16800,250,
    'scheduled','2026-12-01T09:30:00-06:00','2026-12-01T13:45:00-06:00');
  replay_id := import_job('synthetic-replay-cutover',customer_id,property_id,'standard','weekly',16900,250,
    'scheduled','2026-12-01T09:30:00-06:00','2026-12-01T13:45:00-06:00');
  if visit_id is distinct from replay_id
    or (select price_cents from jobs where id=visit_id) <> 16900 then
    raise exception 'An untouched source visit could not be updated';
  end if;

  update jobs set status='assigned' where id=visit_id;
  select to_jsonb(j) into original_row from jobs j where id=visit_id;
  begin
    perform import_job('synthetic-replay-cutover',customer_id,property_id,'standard','weekly',17000,250,
      'scheduled','2026-12-01T10:30:00-06:00','2026-12-01T14:45:00-06:00');
    raise exception 'Replay overwrote an assigned visit';
  exception when check_violation then null;
  end;
  if original_row is distinct from (select to_jsonb(j) from jobs j where id=visit_id) then
    raise exception 'Rejected replay changed the assigned visit';
  end if;

  update jobs set status='in_progress', started_at=clock_timestamp() where id=visit_id;
  select to_jsonb(j) into original_row from jobs j where id=visit_id;
  begin
    perform import_job('synthetic-replay-cutover',customer_id,property_id,'standard','weekly',17000,250,
      'scheduled','2026-12-01T10:30:00-06:00','2026-12-01T14:45:00-06:00');
    raise exception 'Replay overwrote a started visit';
  exception when check_violation then null;
  end;
  if original_row is distinct from (select to_jsonb(j) from jobs j where id=visit_id) then
    raise exception 'Rejected replay changed the started visit';
  end if;
end $$;
rollback;
