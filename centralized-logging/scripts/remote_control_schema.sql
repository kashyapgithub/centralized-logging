-- ============================================================================
-- Centralized Logging — remote control extension (OPTIONAL)
-- ----------------------------------------------------------------------------
-- Run this only if you've built the chrome-debug-logger extension and want:
--   1. The extension's popup to read back recent errors for the current tab.
--   2. Claude (via `query_logs.py command`) to send the extension live
--      commands: flush, grab a localStorage snapshot, attach/detach a tab.
--
-- SECURITY TRADE-OFF — read this before running:
-- This widens the app_logs anon policy from insert-only to insert+SELECT,
-- and adds a new extension_commands table anon can read/update. That's fine
-- as long as this Supabase project's anon key only ever lives in places you
-- control (this extension, your own dev machine). If you ALSO ship this
-- project's anon key inside a public-facing web app (visible in that app's
-- page source to any visitor), anyone who reads it could then see every log
-- row across every app_name in this project. If that's a real scenario for
-- you, use a separate Supabase project for public-facing browser logging
-- and keep this one just for the extension.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Widen app_logs: anon can now SELECT, not just INSERT.
-- ----------------------------------------------------------------------------
drop policy if exists "anon can select logs" on app_logs;
create policy "anon can select logs"
    on app_logs
    for select
    to anon
    using (true);


-- ----------------------------------------------------------------------------
-- 2. Command queue the extension polls.
-- ----------------------------------------------------------------------------
create table if not exists extension_commands (
    id             bigint generated always as identity primary key,
    created_at     timestamptz not null default now(),

    app_name       text,               -- target hostname; null for untargeted commands (e.g. 'status')
    command        text not null check (command in (
                       'flush', 'localstorage_snapshot', 'attach', 'detach', 'status'
                   )),
    payload        jsonb not null default '{}'::jsonb,

    status         text not null default 'pending' check (status in ('pending', 'done', 'failed')),
    result         jsonb,
    completed_at   timestamptz
);

comment on table extension_commands is
    'Command queue polled by the chrome-debug-logger extension. A trusted '
    'client (query_logs.py, using the service key) inserts a row; the '
    'extension (anon key) picks it up, acts on it, and writes status/result '
    'back — a simple request/response over Postgres instead of a socket.';

create index if not exists idx_extension_commands_pending
    on extension_commands (status)
    where status = 'pending';

alter table extension_commands enable row level security;

drop policy if exists "anon can read commands" on extension_commands;
create policy "anon can read commands"
    on extension_commands
    for select
    to anon
    using (true);

drop policy if exists "anon can update commands" on extension_commands;
create policy "anon can update commands"
    on extension_commands
    for update
    to anon
    using (true)
    with check (true);

-- service_role (query_logs.py) bypasses RLS automatically — it's what
-- inserts new commands and polls for the result. No policy needed for it.


-- ----------------------------------------------------------------------------
-- Sanity check:
-- ----------------------------------------------------------------------------
-- insert into extension_commands (command) values ('status') returning id;
-- select * from extension_commands order by created_at desc limit 5;
