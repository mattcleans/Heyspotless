-- The office queue uses the signed-in client, not a service-role page read.
-- Make its existing hosted read contract explicit on fresh installations.
-- Grant SELECT only after checking that every linked table enforces RLS.
do $$ begin
 if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname in ('payment_operations','invoices','customers')
       and c.relkind='r' and c.relrowsecurity) <> 3 then
  raise exception 'Payment review reads require RLS on all three linked tables';
 end if;
end $$;
grant select on public.payment_operations,public.invoices,public.customers to authenticated;
