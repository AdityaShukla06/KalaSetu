-- Support tickets: an artisan raises one from a link in the email sent when
-- an admin deactivates their account or deletes one of their listings. The
-- link carries a signed token (see server/lib/jwt.ts, signTicketToken), not a
-- login, since a deactivated account cannot sign in to reach an authenticated
-- route. Raising a ticket never restores anything by itself: reactivating an
-- artisan is a separate, explicit admin action, and a deleted product is
-- never recreated by any code path.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it. Safe to re-run.

create table if not exists support_tickets (
  id            uuid primary key default gen_random_uuid(),
  artisan_id    uuid not null references users(id) on delete cascade,
  ticket_type   text not null check (ticket_type in ('deactivation', 'product_removal')),
  context       text,
  message       text not null,
  status        text not null default 'open' check (status in ('open', 'resolved')),
  admin_response text,
  resolved_at   timestamptz,
  resolved_by   uuid references users(id),
  created_at    timestamptz not null default now()
);

create index if not exists support_tickets_artisan_id_created_at_idx
  on support_tickets (artisan_id, created_at desc);

create index if not exists support_tickets_status_idx
  on support_tickets (status);

alter table support_tickets enable row level security;

drop policy if exists support_tickets_select_admin on support_tickets;
create policy support_tickets_select_admin on support_tickets
  for select to authenticated
  using (app_current_role() = 'admin');

drop policy if exists support_tickets_select_own on support_tickets;
create policy support_tickets_select_own on support_tickets
  for select to authenticated
  using (artisan_id = auth.uid());
