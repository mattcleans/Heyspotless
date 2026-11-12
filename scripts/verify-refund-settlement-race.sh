#!/usr/bin/env bash
# Run only in a disposable database. All payment and refund IDs are synthetic.
set -euo pipefail
database="${1:?pass a disposable verifier database}"
[[ "$database" == spotless_verify* ]] || { echo 'A disposable verifier database is required.' >&2; exit 1; }
work=$(mktemp -d)
first=''
second=''
cleanup() {
  local result=$?
  for pid in "$first" "$second"; do
    [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  done
  if [ "$result" -ne 0 ]; then
    for log in "$work"/*.log; do [ ! -f "$log" ] || cat "$log" >&2; done
  fi
  rm -rf "$work"
}
trap cleanup EXIT
sql() { PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=15000" psql -X -v ON_ERROR_STOP=1 -qtA -d "$database" "$@"; }
observe() {
  for _ in $(seq 1 100); do
    if [ "$(sql -c "$1")" = 1 ]; then return; fi
    sleep .05
  done
  echo 'The expected settlement overlap was not observed.' >&2
  return 1
}

sql <<'SQL'
insert into public.customers(id,first_name,last_name) values('f6300000-0000-4000-8000-000000000001','SYNTHETIC','Refund race');
insert into public.invoices(id,customer_id,status,subtotal_cents,total_cents)
values('f6300000-0000-4000-8000-000000000002','f6300000-0000-4000-8000-000000000001','sent',17000,17000);
select public.record_payment('f6300000-0000-4000-8000-000000000002',17000,0,'pi_SYNTHETIC_SETTLEMENT_RACE',null,null,false,'card');
select public.record_refund('pi_SYNTHETIC_SETTLEMENT_RACE',2000,'re_SYNTHETIC_SETTLEMENT_RACE',null,null,'correction','pending');
SQL

PGAPPNAME=refund_settlement_first sql >"$work/first.log" 2>&1 <<'SQL' &
begin;
set local role service_role;
select public.settle_refund('re_SYNTHETIC_SETTLEMENT_RACE','succeeded');
select pg_sleep(4);
commit;
SQL
first=$!
observe "select count(*) from pg_stat_activity where datname=current_database() and application_name='refund_settlement_first' and wait_event='PgSleep'"

PGAPPNAME=refund_settlement_second sql >"$work/second.log" 2>&1 <<'SQL' &
begin;
set local role service_role;
select public.settle_refund('re_SYNTHETIC_SETTLEMENT_RACE','succeeded');
commit;
SQL
second=$!
observe "select count(*) from pg_stat_activity w join pg_stat_activity h on h.pid=any(pg_blocking_pids(w.pid)) where w.datname=current_database() and w.application_name='refund_settlement_second' and h.application_name='refund_settlement_first' and w.wait_event_type='Lock'"
wait "$first"; first=''
wait "$second"; second=''

test "$(sql -c "select refunded_cents from public.invoices where id='f6300000-0000-4000-8000-000000000002'")" = 2000
test "$(sed -n '1p' "$work/first.log")" = succeeded
test "$(sed -n '1p' "$work/second.log")" = unchanged
echo 'Concurrent refund settlement applied exactly 2,000 cents once.'
