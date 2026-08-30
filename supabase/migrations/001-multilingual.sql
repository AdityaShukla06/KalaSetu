-- Multilingual migration.
--
-- Products stored English plus Hindi in fixed columns. They now store English
-- plus whatever language the artisan chose, with the language recorded
-- alongside it. Existing rows are treated as Hindi, which is what they were.
--
-- Run this once in the Supabase SQL editor against a database created before
-- the multilingual change. A fresh database created from schema.sql already
-- has the new shape and does not need it. Safe to re-run.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'products' and column_name = 'title_hi'
  ) then
    alter table products rename column title_hi to title_local;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_name = 'products' and column_name = 'description_hi'
  ) then
    alter table products rename column description_hi to description_local;
  end if;
end $$;

alter table products
  add column if not exists local_language text not null default 'hi';

-- users.language was constrained to en and hi. Any of the app's languages is
-- valid now, and the application validates the code against its own list.
alter table users drop constraint if exists users_language_check;
