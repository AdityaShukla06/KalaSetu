-- Adds a product weight and an artisan pincode, the two inputs the rule-based
-- shipping estimator needs on top of a buyer-entered destination pincode.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

alter table users
  add column if not exists pincode text;

alter table users
  drop constraint if exists users_pincode_check;

alter table users
  add constraint users_pincode_check check (pincode is null or pincode ~ '^[1-9][0-9]{5}$');

alter table products
  add column if not exists weight_kg numeric(6, 3);

alter table products
  drop constraint if exists products_weight_kg_check;

alter table products
  add constraint products_weight_kg_check check (weight_kg is null or weight_kg > 0);
