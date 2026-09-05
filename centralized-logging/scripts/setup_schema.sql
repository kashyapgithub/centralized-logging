-- ============================================================================
-- Centralized Logging — schema setup
-- ----------------------------------------------------------------------------
-- Run this ONCE per Supabase project, via the Supabase SQL editor (or `psql`
-- against the project's connection string). Safe to re-run: every statement
-- is idempotent (create-if-not-exists / create-or-replace).
--
-- What this creates:
--   1. app_logs            — the one table every app writes events into
--   2. indexes              — kept fast even at millions of rows
--   3. row level security   — anon key can insert only; service_role bypasses
--   4. app_error_groups      — a view that groups repeat errors by fingerprint
--
-- See references/database-schema.md for the full rationale behind each piece.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------
create table if not exists app_logs (
    id              bigint generated always as identity primary key,
    created_at      timestamptz not null default now(),

    -- who/where -------------------------------------------------------------
    app_name        text not null,
    environment     text not null default 'production',
    host            text,

    -- what happened -----------------------------------------------------
    level           text not null default 'info'
                    check (level in ('debug', 'info', 'warn', 'error', 'fatal')),
    message         text not null,
    error_type      text,
    stack_trace     text,
    context         jsonb not null default '{}'::jsonb,
    fingerprint     text,

    -- where in the code -------------------------------------------------
    source_file     text,
    source_line     integer,
    source_function text,

    -- correlation ---------------------------------------------------------
    request_id      text,
    session_id      text,
    user_ref        text,
    tags            text[] not null default '{}'::text[],
    duration_ms     numeric,

    -- triage ----------------------------------------------------------------
    resolved        boolean not null default false,
    resolved_at     timestamptz,
    resolved_note   text
);

comment on table app_logs is
    'Centralized log/event store for any application. One row per event. '
    'See references/database-schema.md in the centralized-logging skill for '
    'the full column-by-column rationale.';


-- ----------------------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------------------
create index if not exists idx_app_logs_app_time
    on app_logs (app_name, created_at desc);

create index if not exists idx_app_logs_level
    on app_logs (level);

create index if not exists idx_app_logs_fingerprint
    on app_logs (fingerprint);

create index if not exists idx_app_logs_request
    on app_logs (request_id);

-- Speeds up "what's still broken" without paying for it on resolved rows.
create index if not exists idx_app_logs_unresolved
    on app_logs (app_name, fingerprint)
    where resolved = false;


-- ----------------------------------------------------------------------------
-- 3. Row Level Security
-- ----------------------------------------------------------------------------
alter table app_logs enable row level security;

-- Untrusted clients (browser/mobile using the anon key) may only INSERT.
-- No select/update/delete for anon — a leaked anon key can add noise, never
-- read or tamper with existing events.
drop policy if exists "anon can insert logs" on app_logs;
create policy "anon can insert logs"
    on app_logs
    for insert
    to anon
    with check (true);

-- service_role (used server-side via SUPABASE_SERVICE_KEY) bypasses RLS
-- automatically — no policy needed for it. That's what query_logs.py uses.


-- ----------------------------------------------------------------------------
-- 4. Grouping view — turns raw rows into "distinct problems, ranked"
-- ----------------------------------------------------------------------------
create or replace view app_error_groups as
select
    app_name,
    fingerprint,
    error_type,
    level,
    count(*)                                                as occurrences,
    min(created_at)                                          as first_seen,
    max(created_at)                                          as last_seen,
    (array_agg(message order by created_at desc))[1]         as latest_message,
    (array_agg(stack_trace order by created_at desc))[1]     as latest_stack_trace,
    bool_and(resolved)                                       as fully_resolved
from app_logs
where fingerprint is not null
group by app_name, fingerprint, error_type, level
order by max(created_at) desc;

comment on view app_error_groups is
    'One row per distinct fingerprint (i.e. per distinct bug), not per raw '
    'event. Use this to see what is actually broken without scrolling '
    'through duplicate rows.';


-- ----------------------------------------------------------------------------
-- Done. Sanity check:
-- ----------------------------------------------------------------------------
-- select count(*) from app_logs;
-- select * from app_error_groups limit 5;
