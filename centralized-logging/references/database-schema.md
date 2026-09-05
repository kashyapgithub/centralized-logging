# Database Schema — `app_logs`

This is the reference doc for what `scripts/setup_schema.sql` creates and *why*.
Read this before running the SQL so you can explain choices to the user if asked,
and before writing queries so you know what's queryable.

## Design goals

1. **Every little detail, one row per event.** No normalization tax at write
   time — write fast, structure loosely (`context jsonb`), query flexibly later.
2. **Cheap to write from anywhere.** No stored procedure required — a plain
   `INSERT` (or REST `POST`) into one table is enough.
3. **Cheap to make sense of at scale.** A fingerprint + grouping view turns
   "10,000 rows" into "12 distinct problems, ranked by frequency."

## Table: `app_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint generated always as identity` | Primary key. |
| `created_at` | `timestamptz default now()` | When the event happened. Always UTC. |
| `app_name` | `text not null` | Which application logged this. Slug it, e.g. `dawaai-backend`. This is what lets one table serve every project. |
| `environment` | `text default 'production'` | `development` / `staging` / `production`. |
| `level` | `text not null` | One of `debug`, `info`, `warn`, `error`, `fatal` (enforced by CHECK). |
| `message` | `text not null` | Human-readable summary. Keep the *variable* parts (ids, values) out of this and into `context` — that's what makes fingerprinting work. |
| `error_type` | `text` | Exception/class name if this came from a caught error, e.g. `TypeError`, `ValidationError`. Null for plain log lines. |
| `stack_trace` | `text` | Full stack trace, uncut. This table has no length limit worth worrying about — don't truncate at write time. |
| `context` | `jsonb default '{}'` | Anything else: request payload, user action, feature flags, retry count, whatever the app knows at the moment of failure. This is the "every little detail" field. |
| `fingerprint` | `text` | Hash used to group repeats of the same underlying issue. See below. |
| `source_file` / `source_line` / `source_function` | `text` / `int` / `text` | Where in the code this fired, if known. |
| `request_id` | `text` | Correlates every log line produced while handling one request/job. |
| `session_id` | `text` | Correlates every log line produced during one user/agent session. |
| `user_ref` | `text` | The *app's own* identifier for who was affected (e.g. an internal user id). Don't put emails/PII here — a reference the app can look up is enough. |
| `host` | `text` | Hostname/instance/container id, useful when an app runs on multiple machines. |
| `tags` | `text[] default '{}'` | Free-form labels, e.g. `{payment,retry}`. |
| `duration_ms` | `numeric` | Optional — how long the operation took, for perf-flavored events. |
| `resolved` | `boolean default false` | Has a human/agent addressed the underlying issue this fingerprint represents? |
| `resolved_at` | `timestamptz` | Set when `resolved` flips to true. |
| `resolved_note` | `text` | What fixed it / why it's not actionable. |

### Fingerprinting

`fingerprint` should be computed **client-side** (in the logger, not the DB) as
a hash of `error_type + message-with-variables-stripped` — e.g.
`sha256(error_type + ":" + re.sub(r'\d+', '#', message))`. The provided
`logger_client.py` / `logger_client.js` do this automatically. This is what
lets `app_error_groups` (below) collapse "same bug, 400 occurrences" into one
line instead of 400.

## Indexes

```sql
create index idx_app_logs_app_time on app_logs (app_name, created_at desc);
create index idx_app_logs_level on app_logs (level);
create index idx_app_logs_fingerprint on app_logs (fingerprint);
create index idx_app_logs_request on app_logs (request_id);
create index idx_app_logs_unresolved on app_logs (app_name, fingerprint) where resolved = false;
```

The `unresolved` partial index keeps the "what's still broken" query fast even
as the table grows into millions of resolved rows.

## Row Level Security

RLS is **on**. The intent:

- `service_role` (used server-side, via `SUPABASE_SERVICE_KEY`) bypasses RLS
  entirely — full read/write. This is what `query_logs.py` and any trusted
  backend uses.
- `anon` (used by browser/mobile clients, via `SUPABASE_ANON_KEY`) can
  **insert only** — no select, update, or delete. A compromised or nosy client
  can add log noise at worst, never read other users' events or tamper with
  history.

```sql
alter table app_logs enable row level security;

create policy "anon can insert logs"
  on app_logs for insert
  to anon
  with check (true);

-- service_role bypasses RLS by default; no policy needed for it.
```

If a project genuinely needs authenticated end-users to *read* their own logs
(e.g. an in-app diagnostics screen), add a narrower policy scoped to
`user_ref = auth.uid()` rather than opening `select` to everyone — don't do
this by default.

## View: `app_error_groups`

Turns raw rows into "distinct problems, ranked":

```sql
create or replace view app_error_groups as
select
  app_name,
  fingerprint,
  error_type,
  level,
  count(*)                                   as occurrences,
  min(created_at)                            as first_seen,
  max(created_at)                            as last_seen,
  (array_agg(message order by created_at desc))[1]      as latest_message,
  (array_agg(stack_trace order by created_at desc))[1]  as latest_stack_trace,
  bool_and(resolved)                         as fully_resolved
from app_logs
where fingerprint is not null
group by app_name, fingerprint, error_type, level
order by max(created_at) desc;
```

`query_logs.py groups` reads from this view.

## Retention

Raw event tables grow fast — don't let this run unbounded forever. Suggested
default: keep 30 days of `debug`/`info`, 90 days of `warn`/`error`/`fatal`.

```sql
delete from app_logs
where (level in ('debug','info') and created_at < now() - interval '30 days')
   or (level in ('warn','error','fatal') and created_at < now() - interval '90 days');
```

Offer to schedule this (Supabase's built-in `pg_cron`, or a Supabase Edge
Function on a schedule, or an external cron hitting a small cleanup script) —
don't run it silently without the user's go-ahead, and never delete
`resolved = false` rows automatically regardless of age.
