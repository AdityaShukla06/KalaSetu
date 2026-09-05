-- Adds the pricing overcharge auto-flag column.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

alter table products
  add column if not exists auto_flag_reason text;
