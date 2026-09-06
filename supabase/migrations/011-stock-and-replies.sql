-- Adds products.in_stock (artisan-controlled availability flag, buyers can
-- still inquire on an out-of-stock listing) and inquiries.reply_message (the
-- artisan's typed reply, emailed to the buyer and shown on their own inquiry
-- list). Run this once in the Supabase SQL editor against a database created
-- before this change. A fresh database created from schema.sql already has
-- this shape and does not need it. Safe to re-run.

alter table products
  add column if not exists in_stock boolean not null default true;

alter table inquiries
  add column if not exists reply_message text;

create index if not exists products_in_stock_idx
  on products (in_stock);
