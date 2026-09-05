-- Three-role migration: artisan, buyer, admin.
--
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

alter table users
  add column if not exists role text not null default 'artisan' check (role in ('artisan', 'buyer', 'admin'));

alter table products
  add column if not exists flagged boolean not null default false;

alter table products
  add column if not exists flag_reason text;

create index if not exists products_status_flagged_idx
  on products (status, flagged);

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

alter table inquiries enable row level security;

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

revoke update (role) on users from authenticated, anon;

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

drop policy if exists products_select_own on products;
create policy products_select_own on products
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists products_select_published on products;
create policy products_select_published on products
  for select to authenticated
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

drop policy if exists product_images_insert_own_folder on storage.objects;
create policy product_images_insert_own_folder on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
