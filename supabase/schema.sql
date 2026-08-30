-- KalaSetu database schema.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is guarded.

create extension if not exists "pgcrypto";

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  display_name   text,
  shop_name      text,
  language       text not null default 'en',
  total_products integer not null default 0,
  created_at     timestamptz not null default now()
);

create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  category        text not null,
  title_en        text not null,
  title_local     text not null,
  description_en  text not null,
  description_local text not null,
  local_language  text not null default 'en',
  image_url       text not null,
  price           numeric(12, 2) not null check (price > 0),
  material_cost   numeric(12, 2) not null check (material_cost > 0),
  status          text not null default 'published' check (status in ('draft', 'published', 'failed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists products_user_id_created_at_idx
  on products (user_id, created_at desc);

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

-- The API talks to Postgres with the service role key, which bypasses RLS.
-- RLS is still enabled with no policies so that the public anon key cannot
-- read or write anything if it ever leaks into the frontend bundle.
alter table users     enable row level security;
alter table products  enable row level security;
alter table otp_codes enable row level security;

-- Storage bucket for product images. Public read so <img src> works,
-- writes only ever happen server side with the service role key.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;
