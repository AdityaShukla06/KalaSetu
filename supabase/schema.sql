-- KalaSetu database schema.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is guarded.

create extension if not exists "pgcrypto";

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  display_name   text,
  shop_name      text,
  region         text,
  language       text not null default 'en',
  role           text not null default 'artisan' check (role in ('artisan', 'buyer', 'admin')),
  is_active      boolean not null default true,
  total_products integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists users_is_active_idx
  on users (is_active);

create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  category        text not null,
  material        text,
  region          text,
  artisan_name    text,
  title_en        text not null,
  title_local     text not null,
  description_en  text not null,
  description_local text not null,
  local_language  text not null default 'en',
  image_url       text not null,
  price           numeric(12, 2) not null check (price > 0),
  material_cost   numeric(12, 2) not null check (material_cost > 0),
  status          text not null default 'published' check (status in ('draft', 'published', 'failed')),
  flagged         boolean not null default false,
  flag_reason     text,
  auto_flag_reason text,
  review_status   text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected', 'flagged')),
  reviewed_at     timestamptz,
  reviewed_by     uuid references users(id),
  review_reason   text,
  passport_id     text not null unique,
  technique       text,
  time_taken      text,
  gi_tag          text,
  care_instructions text,
  product_story   text,
  story_generated_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists products_user_id_created_at_idx
  on products (user_id, created_at desc);

create index if not exists products_status_flagged_idx
  on products (status, flagged);

create index if not exists products_marketplace_filter_idx
  on products (status, flagged, category, material, region);

create index if not exists products_price_idx
  on products (price);

create index if not exists products_review_status_idx
  on products (review_status);

create table if not exists passport_counters (
  year       int primary key,
  last_value int not null default 0
);

alter table passport_counters enable row level security;

create table if not exists inquiries (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  buyer_id    uuid not null references users(id) on delete cascade,
  artisan_id  uuid not null references users(id) on delete cascade,
  message     text not null,
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_at  timestamptz not null default now()
);

create index if not exists inquiries_buyer_id_created_at_idx
  on inquiries (buyer_id, created_at desc);

create index if not exists inquiries_artisan_id_created_at_idx
  on inquiries (artisan_id, created_at desc);

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

create table if not exists otp_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists otp_codes_email_created_at_idx
  on otp_codes (email, created_at desc);

-- Keeps users.total_products correct without a read-modify-write race.
create or replace function increment_total_products(target_user uuid, delta integer)
returns void
language sql
as $$
  update users
  set total_products = greatest(0, total_products + delta)
  where id = target_user;
$$;

-- Atomically returns the next passport sequence number for a given year.
-- The upsert's row-level lock is what makes this safe under concurrent
-- product creation; the application formats the ART-YYYY-NNNNNN string.
create or replace function next_passport_number(target_year int)
returns int
language sql
as $$
  insert into passport_counters (year, last_value)
  values (target_year, 1)
  on conflict (year) do update set last_value = passport_counters.last_value + 1
  returning last_value;
$$;

create or replace function app_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from users where id = auth.uid();
$$;

grant execute on function app_current_role() to authenticated, anon;

create or replace function protect_product_moderation_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.flagged is distinct from old.flagged or new.flag_reason is distinct from old.flag_reason)
     and app_current_role() is not null and app_current_role() <> 'admin' then
    raise exception 'Only an admin can change moderation fields';
  end if;
  return new;
end;
$$;

drop trigger if exists products_protect_moderation on products;
create trigger products_protect_moderation
  before update on products
  for each row execute function protect_product_moderation_columns();

-- The API talks to Postgres with the service role key, which bypasses RLS
-- entirely (BYPASSRLS), so none of the policies below constrain the Express
-- server. They exist so the anon/authenticated Postgres roles are locked
-- down to the same three-role rules if anything ever queries Supabase
-- directly instead of through the API.
alter table users      enable row level security;
alter table products   enable row level security;
alter table inquiries  enable row level security;
alter table audit_log  enable row level security;
alter table otp_codes  enable row level security;

revoke update (role) on users from authenticated, anon;
revoke update (is_active) on users from authenticated, anon;

drop policy if exists users_select_own on users;
create policy users_select_own on users
  for select to authenticated
  using (id = auth.uid());

drop policy if exists users_select_admin on users;
create policy users_select_admin on users
  for select to authenticated
  using (app_current_role() = 'admin');

drop policy if exists users_update_own on users;
create policy users_update_own on users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists users_update_admin on users;
create policy users_update_admin on users
  for update to authenticated
  using (app_current_role() = 'admin')
  with check (app_current_role() = 'admin');

drop policy if exists products_select_own on products;
create policy products_select_own on products
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists products_select_published on products;
create policy products_select_published on products
  for select to authenticated
  using (status = 'published' and flagged = false);

drop policy if exists products_select_public_passport on products;
create policy products_select_public_passport on products
  for select to anon
  using (status = 'published' and flagged = false);

drop policy if exists products_select_admin on products;
create policy products_select_admin on products
  for select to authenticated
  using (app_current_role() = 'admin');

drop policy if exists products_insert_artisan on products;
create policy products_insert_artisan on products
  for insert to authenticated
  with check (app_current_role() = 'artisan' and user_id = auth.uid());

drop policy if exists products_update_own on products;
create policy products_update_own on products
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists products_update_admin on products;
create policy products_update_admin on products
  for update to authenticated
  using (app_current_role() = 'admin')
  with check (app_current_role() = 'admin');

drop policy if exists products_delete_own on products;
create policy products_delete_own on products
  for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists inquiries_insert_buyer on inquiries;
create policy inquiries_insert_buyer on inquiries
  for insert to authenticated
  with check (app_current_role() = 'buyer' and buyer_id = auth.uid());

drop policy if exists inquiries_select_buyer on inquiries;
create policy inquiries_select_buyer on inquiries
  for select to authenticated
  using (buyer_id = auth.uid());

drop policy if exists inquiries_select_artisan on inquiries;
create policy inquiries_select_artisan on inquiries
  for select to authenticated
  using (artisan_id = auth.uid());

drop policy if exists inquiries_select_admin on inquiries;
create policy inquiries_select_admin on inquiries
  for select to authenticated
  using (app_current_role() = 'admin');

drop policy if exists inquiries_update_parties on inquiries;
create policy inquiries_update_parties on inquiries
  for update to authenticated
  using (buyer_id = auth.uid() or artisan_id = auth.uid())
  with check (buyer_id = auth.uid() or artisan_id = auth.uid());

drop policy if exists audit_log_select_admin on audit_log;
create policy audit_log_select_admin on audit_log
  for select to authenticated
  using (app_current_role() = 'admin');

-- Storage bucket for product images. Public read so <img src> works,
-- writes only ever happen server side with the service role key.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists product_images_insert_own_folder on storage.objects;
create policy product_images_insert_own_folder on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
