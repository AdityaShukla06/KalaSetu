-- Records the language each inquiry message was actually written in, so the
-- reader can be offered an accurate "translated to X from Y" instead of the
-- app having to guess. The sender's own interface language at the moment they
-- pressed send is the value stored, which is the cheapest reliable signal we
-- have and costs no extra model call.
-- Nullable on purpose: messages written before this migration have no recorded
-- language, and the translate endpoint detects the source for those instead.
-- Safe to run more than once.
-- Run this once in the Supabase SQL editor against a database created before
-- this change. A fresh database created from schema.sql already has it.

alter table inquiry_messages
  add column if not exists body_language text;
