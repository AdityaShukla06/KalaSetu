-- Admin accounts sign in with a password instead of an emailed OTP.
-- users.password_hash is null for every artisan/buyer account (they still
-- use OTP); it is only ever set out-of-band by scripts/set-admin-password.mts,
-- never through any route the running app exposes to itself.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

alter table users
  add column if not exists password_hash text;

alter table users
  add column if not exists failed_login_attempts integer not null default 0;

alter table users
  add column if not exists locked_until timestamptz;
