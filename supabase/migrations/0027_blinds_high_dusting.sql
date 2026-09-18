-- ============================================================================
-- 0027 — blinds / high dusting extra
--
-- A $30 flat extra after Organization (sort_order 10). Minutes sit in the same
-- band as Walls ($25 / 20 min). Extras stay flat, never discounted, and were
-- not part of the August 2026 increase.
--
-- Do not rewrite 0002_price_book.sql: that file is the published core book.
-- Additive extras land here so existing databases pick up the row without a
-- wholesale re-seed.
-- ============================================================================

create or replace function app_schema_version() returns integer
language sql immutable as $$ select 27 $$;

insert into price_book_extras (item_key,name,price_cents,unit_label,clean_minutes,sort_order) values
  ('blinds_high_dusting', 'Blinds / High Dusting', 3000, 'flat', 20, 11)
on conflict (item_key) do nothing;
