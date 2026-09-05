-- Adds an is_seed flag so demo/seed data (scripts/seed-demo-data.mjs) can be
-- told apart from real accounts and listings, and wiped cleanly.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

alter table users
  add column if not exists is_seed boolean not null default false;

alter table products
  add column if not exists is_seed boolean not null default false;

create index if not exists users_is_seed_idx
  on users (is_seed);

create index if not exists products_is_seed_idx
  on products (is_seed);
