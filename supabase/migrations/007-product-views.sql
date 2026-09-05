-- Adds view tracking for the artisan analytics dashboard.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

create table if not exists product_views (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  viewer_role text check (viewer_role in ('artisan', 'buyer', 'admin')),
  region      text,
  created_at  timestamptz not null default now()
);

create index if not exists product_views_product_id_created_at_idx
  on product_views (product_id, created_at desc);

create index if not exists product_views_created_at_idx
  on product_views (created_at desc);

alter table product_views enable row level security;

drop policy if exists product_views_select_own on product_views;
create policy product_views_select_own on product_views
  for select to authenticated
  using (exists (select 1 from products p where p.id = product_views.product_id and p.user_id = auth.uid()));

drop policy if exists product_views_select_admin on product_views;
create policy product_views_select_admin on product_views
  for select to authenticated
  using (app_current_role() = 'admin');
