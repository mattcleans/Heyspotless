#!/usr/bin/env bash
# Applies every migration to a throwaway database and checks quote_price()
# against the published pricelist totals. Requires a local Postgres.
set -euo pipefail

DB="${1:-spotless_verify}"
PSQL="psql -v ON_ERROR_STOP=1 -q"

sudo -u postgres dropdb --if-exists "$DB"
sudo -u postgres createdb "$DB"

# Supabase provides auth.uid() at runtime. Stub it so RLS policies compile
# locally; the real thing is supplied by Supabase in every deployed
# environment. This stub exists only for verification and is not a migration.
sudo -u postgres $PSQL -d "$DB" <<'SQL'
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$f$;
SQL

for f in supabase/migrations/*.sql; do
  echo "  applying $(basename "$f")"
  sudo -u postgres $PSQL -d "$DB" -f "$f"
done
echo "  all migrations applied"

# --- golden check: quote_price() must reproduce the published pricelist ------
echo "  checking quote_price() against the 9 Aug 2026 pricelist"
sudo -u postgres $PSQL -d "$DB" <<'SQL'
do $$
declare
  r record; v_actual integer; v_fail integer := 0; v_ok integer := 0;
begin
  for r in select * from (values
    (1,1,15700,25800,32400),(2,1,17700,29200,36300),(2,2,19900,32800,40800),
    (3,2,21900,36200,44700),(3,3,24100,39800,49200),(4,2,23900,39600,48600),
    (4,3,26100,43200,53100),(5,3,28100,46600,57000),(6,4,32300,53600,65400)
  ) as t(beds,baths,std,deep,mio) loop
    select total_cents into v_actual from quote_price('standard','one_time',r.beds,r.baths);
    if v_actual = r.std then v_ok := v_ok+1; else v_fail := v_fail+1;
      raise warning 'standard %bd/%ba: got %, want %', r.beds,r.baths,v_actual,r.std; end if;
    select total_cents into v_actual from quote_price('deep','one_time',r.beds,r.baths);
    if v_actual = r.deep then v_ok := v_ok+1; else v_fail := v_fail+1;
      raise warning 'deep %bd/%ba: got %, want %', r.beds,r.baths,v_actual,r.deep; end if;
    select total_cents into v_actual from quote_price('move_in_out','one_time',r.beds,r.baths);
    if v_actual = r.mio then v_ok := v_ok+1; else v_fail := v_fail+1;
      raise warning 'move_in_out %bd/%ba: got %, want %', r.beds,r.baths,v_actual,r.mio; end if;
  end loop;

  -- a service/frequency pair that does not exist must raise, not quote $0
  begin
    perform * from quote_price('move_in_out','weekly',3,2);
    v_fail := v_fail + 1;
    raise warning 'move_in_out/weekly returned a quote instead of raising';
  exception when sqlstate 'P0001' then v_ok := v_ok + 1;
  end;

  raise notice '% passed, % failed', v_ok, v_fail;
  if v_fail > 0 then raise exception '% price book assertions failed', v_fail; end if;
end $$;
SQL
echo "  price book verified"
