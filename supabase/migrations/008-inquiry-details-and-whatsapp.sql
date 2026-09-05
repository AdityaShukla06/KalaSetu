-- Adds structured inquiry details (quantity, contact preference), inbox
-- tracking (read/responded/notified timestamps), and an optional artisan
-- WhatsApp number.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

alter table users
  add column if not exists whatsapp_number text;

alter table inquiries
  add column if not exists quantity integer;

alter table inquiries
  drop constraint if exists inquiries_quantity_check;

alter table inquiries
  add constraint inquiries_quantity_check check (quantity is null or quantity > 0);

alter table inquiries
  add column if not exists contact_preference text;

alter table inquiries
  drop constraint if exists inquiries_contact_preference_check;

alter table inquiries
  add constraint inquiries_contact_preference_check
  check (contact_preference in ('email', 'phone', 'whatsapp'));

alter table inquiries
  add column if not exists contact_value text;

alter table inquiries
  add column if not exists read_at timestamptz;

alter table inquiries
  add column if not exists responded_at timestamptz;

alter table inquiries
  add column if not exists notified_at timestamptz;
