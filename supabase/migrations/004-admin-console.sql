-- Admin console: artisan deactivation, retrospective listing review, and an
-- audit trail.
--
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.
--
-- All new columns are nullable or carry a safe default. Existing users and
-- products are simply "active" and "pending review" until an admin acts on
-- them; nothing is backfilled or guessed, and no existing row is changed in
-- a way that alters its current behaviour (publishing stays instant; review
-- is retrospective, not a gate).

alter table users
  add column if not exists is_active boolean not null default true;

create index if not exists users_is_active_idx
  on users (is_active);

alter table products
  add column if not exists review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected', 'flagged'));

alter table products
  add column if not exists reviewed_at timestamptz;

alter table products
  add column if not exists reviewed_by uuid references users(id);

alter table products
  add column if not exists review_reason text;

create index if not exists products_review_status_idx
  on products (review_status);

create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  target_table text not null,
  target_id   uuid not null,
  reason      text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_created_at_idx
  on audit_log (created_at desc);

create index if not exists audit_log_target_idx
  on audit_log (target_table, target_id);

alter table audit_log enable row level security;

revoke update (is_active) on users from authenticated, anon;

drop policy if exists users_update_admin on users;
create policy users_update_admin on users
  for update to authenticated
  using (app_current_role() = 'admin')
  with check (app_current_role() = 'admin');

drop policy if exists audit_log_select_admin on audit_log;
create policy audit_log_select_admin on audit_log
  for select to authenticated
  using (app_current_role() = 'admin');
