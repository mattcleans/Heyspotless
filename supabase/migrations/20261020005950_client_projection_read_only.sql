-- Client-facing projections are read models, never profile editing APIs.
-- Supabase default grants can give authenticated users write access to views.
revoke all on public.cleaner_profiles, public.cleaner_reviews,
  public.client_visit_assignments, public.visit_backup_status
  from public, anon, authenticated;
grant select on public.cleaner_profiles, public.cleaner_reviews,
  public.client_visit_assignments, public.visit_backup_status
  to authenticated, service_role;
