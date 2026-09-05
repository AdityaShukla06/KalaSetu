-- Buyer marketplace fields: region, material, and a denormalized artisan name.
--
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.
--
-- All new columns are nullable. Existing accounts and products are simply
-- unspecified until an artisan fills them in; nothing is backfilled or
-- guessed, and no existing row is changed.

alter table users
  add column if not exists region text;

alter table products
  add column if not exists material text;

alter table products
  add column if not exists region text;

alter table products
  add column if not exists artisan_name text;

create index if not exists products_marketplace_filter_idx
  on products (status, flagged, category, material, region);

create index if not exists products_price_idx
  on products (price);
