-- Craft Heritage Passport: a public, self-declared provenance certificate
-- per product, with a sequential human-readable ID (ART-YYYY-NNNNNN) and an
-- AI-generated story that is written once and stored, never regenerated.
--
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.
--
-- The new product columns are nullable except passport_id, which every
-- existing product is backfilled with below, numbered sequentially within
-- the year it was actually created (oldest first), so the sequence stays
-- meaningful rather than jumping to today's year for old listings. Nothing
-- is guessed for the other new fields; they stay empty until an artisan
-- fills them in for a listing, and the story stays empty until generated.

alter table products
  add column if not exists technique text;

alter table products
  add column if not exists time_taken text;

alter table products
  add column if not exists gi_tag text;

alter table products
  add column if not exists care_instructions text;

alter table products
  add column if not exists product_story text;

alter table products
  add column if not exists story_generated_at timestamptz;

alter table products
  add column if not exists passport_id text;

create table if not exists passport_counters (
  year       int primary key,
  last_value int not null default 0
);

alter table passport_counters enable row level security;

create or replace function next_passport_number(target_year int)
returns int
language sql
as $$
  insert into passport_counters (year, last_value)
  values (target_year, 1)
  on conflict (year) do update set last_value = passport_counters.last_value + 1
  returning last_value;
$$;

-- Backfill: number every existing product sequentially within the year it
-- was created, oldest first, so a listing from 2025 gets an ART-2025-...
-- id rather than being folded into today's sequence.
update products p
set passport_id = 'ART-' || sub.yr || '-' || lpad(sub.rn::text, 6, '0')
from (
  select
    id,
    extract(year from created_at)::int as yr,
    row_number() over (partition by extract(year from created_at) order by created_at) as rn
  from products
  where passport_id is null
) sub
where p.id = sub.id;

-- Seed the counters so the next real insert continues the sequence rather
-- than colliding with a backfilled number.
insert into passport_counters (year, last_value)
select extract(year from created_at)::int as yr, count(*)
from products
group by extract(year from created_at)::int
on conflict (year) do update set last_value = greatest(passport_counters.last_value, excluded.last_value);

alter table products
  alter column passport_id set not null;

create unique index if not exists products_passport_id_idx
  on products (passport_id);

drop policy if exists products_select_public_passport on products;
create policy products_select_public_passport on products
  for select to anon
  using (status = 'published' and flagged = false);
