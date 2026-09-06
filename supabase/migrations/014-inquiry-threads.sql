-- Turns an inquiry from one buyer message plus one optional artisan reply
-- into a real back-and-forth thread. Existing message/reply_message content
-- is copied into the new inquiry_messages table before the old columns are
-- dropped, so no conversation history is lost. Guarded by column-existence
-- checks throughout, so this is safe to run more than once, including after
-- the old columns are already gone.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has this
-- shape and does not need it.

create table if not exists inquiry_messages (
  id          uuid primary key default gen_random_uuid(),
  inquiry_id  uuid not null references inquiries(id) on delete cascade,
  sender_role text not null check (sender_role in ('buyer', 'artisan')),
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists inquiry_messages_inquiry_id_created_at_idx
  on inquiry_messages (inquiry_id, created_at asc);

alter table inquiries
  add column if not exists artisan_last_read_at timestamptz;

alter table inquiries
  add column if not exists buyer_last_read_at timestamptz;

do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'inquiries' and column_name = 'message') then
    insert into inquiry_messages (inquiry_id, sender_role, body, created_at)
    select id, 'buyer', message, created_at
    from inquiries
    where message is not null
      and not exists (select 1 from inquiry_messages im where im.inquiry_id = inquiries.id);
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'inquiries' and column_name = 'reply_message') then
    insert into inquiry_messages (inquiry_id, sender_role, body, created_at)
    select id, 'artisan', reply_message, coalesce(responded_at, created_at)
    from inquiries
    where reply_message is not null
      and not exists (
        select 1 from inquiry_messages im where im.inquiry_id = inquiries.id and im.sender_role = 'artisan'
      );
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'inquiries' and column_name = 'read_at') then
    update inquiries set artisan_last_read_at = read_at where read_at is not null and artisan_last_read_at is null;
  end if;
end $$;

alter table inquiries drop column if exists message;
alter table inquiries drop column if exists reply_message;
alter table inquiries drop column if exists responded_at;
alter table inquiries drop column if exists read_at;
alter table inquiries drop column if exists notified_at;

alter table inquiry_messages enable row level security;

drop policy if exists inquiry_messages_select_buyer on inquiry_messages;
create policy inquiry_messages_select_buyer on inquiry_messages
  for select to authenticated
  using (exists (select 1 from inquiries i where i.id = inquiry_messages.inquiry_id and i.buyer_id = auth.uid()));

drop policy if exists inquiry_messages_select_artisan on inquiry_messages;
create policy inquiry_messages_select_artisan on inquiry_messages
  for select to authenticated
  using (exists (select 1 from inquiries i where i.id = inquiry_messages.inquiry_id and i.artisan_id = auth.uid()));

drop policy if exists inquiry_messages_select_admin on inquiry_messages;
create policy inquiry_messages_select_admin on inquiry_messages
  for select to authenticated
  using (app_current_role() = 'admin');
