---
name: centralized-logging
description: >
  Set up centralized, queryable error/event logging for ANY application (any
  language — Node, Python, Go, PHP, mobile, browser, etc.) backed by a
  Supabase/Postgres table, and use it to actively debug production issues.
  Trigger this skill whenever the user asks to "add logging", "set up
  centralized logging", "track errors", "log everything to a database",
  "debug what went wrong", "why did my app crash / fail", "check the error
  logs", or wants a single place to see every error/event across one or more
  apps. Also trigger when the user pastes an error/stack trace and asks you
  to investigate — use the query scripts here to search stored logs for
  related occurrences before guessing. Covers DB schema design, write-side
  client snippets per language, and read-side CLI tools for the agent to
  search, group, and tail logs.
---

# Centralized Logging

A drop-in, language-agnostic logging system: every app writes structured log/error
events straight into one Supabase/Postgres table over plain HTTPS, and Claude (you)
can query that table directly to figure out what actually went wrong — instead of
asking the user to paste logs by hand.

Two sides to this skill:

1. **Write side** — get events *into* the `app_logs` table from whatever app the
   user is building (any language).
2. **Read side** — a CLI (`scripts/query_logs.py`) you run yourself to search,
   group, and tail those events when debugging.

## Bundled resources — read these before building

| File | When to open it |
|---|---|
| `references/database-schema.md` | Always, first. Full annotated schema, RLS policy, indexes, the error-grouping view, and the retention/cleanup query. |
| `references/client-integration.md` | When wiring a specific app up to write logs. Has a generic HTTP/cURL recipe (works for *any* language) plus ready snippets for Node.js, Python, Go, and browser JS. |
| `scripts/setup_schema.sql` | Run this once (via Supabase SQL editor or `psql`) to create the table, indexes, view, and RLS policies. |
| `scripts/logger_client.py` | Copyable, batched, background-flushing logger for Python apps. Import it or adapt it. |
| `scripts/logger_client.js` | Same, for Node.js apps (CommonJS, zero dependencies beyond `fetch`). |
| `scripts/query_logs.py` | The agent's debugging CLI — search, group-by-fingerprint, tail, mark-resolved, and (if `remote_control_schema.sql` has been run) send live commands to the chrome-debug-logger extension. |
| `scripts/remote_control_schema.sql` | Optional. Adds a command queue plus read-back access, so the extension and this CLI can talk both ways. Has its own security trade-off — read the comment at the top of the file before running it. |

Don't paste the full contents of every reference file into your response to the
user — read what you need, then act. Keep the conversation focused on progress,
not on reproducing these docs.

## Workflow

### 1. Provision the database (once per Supabase project)

- If the user already has a Supabase project (check `/areas/personal-ai-agent.md`-style
  context or just ask), reuse it — this table is safe to add alongside existing
  tables, it's fully namespaced by `app_name`.
- Otherwise help them create a free Supabase project.
- Run `scripts/setup_schema.sql` against it (Supabase SQL editor is the easiest
  path — paste and run). Confirm the table `app_logs` and view `app_error_groups`
  exist before moving on.
- Collect three values and get them into the target app's env/secrets — never
  hardcode them:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY` (service_role — server-side / trusted environments only)
  - `SUPABASE_ANON_KEY` (anon/public — only for untrusted clients like browser JS;
    the RLS policy in the schema restricts what this key can do to insert-only)

### 2. Wire up the app to write logs

- Read `references/client-integration.md`.
- If the app is Node.js or Python, copy the matching `scripts/logger_client.*`
  into the project and adapt the `appName`/`app_name` and log calls to the app's
  actual entry points, error handlers, and request middleware.
- For any other language, follow the generic HTTP/cURL pattern in that same file
  — it's just a POST to a Supabase REST endpoint, so it works everywhere.
- Capture real detail, not just a message: exception type, full stack trace,
  request id, environment, and a free-form `context` object for anything
  app-specific (payload, user action, feature flag state, etc). The whole point
  is that *every little detail* needed to reconstruct the failure is in one row.
- Wrap this in the app's global error handler / uncaught-exception hook so
  logging happens automatically, not only where a developer remembered to add
  a log line.

### 3. Debug with it

When the user reports something broke, or pastes an error, don't just reason
from the snippet they gave you — pull real data:

```bash
# most recent errors for an app, last hour
python3 scripts/query_logs.py recent --app <app_name> --level error --minutes 60

# same failure happening repeatedly? group by fingerprint
python3 scripts/query_logs.py groups --app <app_name>

# follow one request/session across every log line it produced
python3 scripts/query_logs.py trace --request-id <id>

# live tail while reproducing a bug
python3 scripts/query_logs.py tail --app <app_name>

# once fixed, close the loop so it stops surfacing as "open"
python3 scripts/query_logs.py resolve --fingerprint <fp> --note "fixed in v1.2, off-by-one in retry loop"

# talk to the chrome-debug-logger extension directly (needs remote_control_schema.sql run once)
python3 scripts/query_logs.py command --action localstorage_snapshot --app <hostname>
python3 scripts/query_logs.py command --action flush
```

The script reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the environment
— ask the user for these once, then reuse them for the rest of the session.

### 4. Housekeeping

Point out (don't force) that raw event tables grow fast. `references/database-schema.md`
includes a retention query — mention it, and offer to schedule it (e.g. a
Supabase cron/Edge Function, or a plain cron job hitting the DB) rather than
silently deleting anything.

## Design principles this skill follows

- **One table, any app** — every row is tagged `app_name` + `environment`, so
  one Supabase project can back every project the user builds, not just one.
- **No server to run** — writes go straight to Supabase's auto-generated REST
  API (PostgREST). No custom ingest service to deploy, host, or keep alive.
- **Fingerprinting over noise** — a hash of `error_type + normalized message`
  groups repeats of the same bug into one row in `app_error_groups`, so a loop
  that fails 400 times shows up as one thing to investigate, not 400.
- **Detail now, judgment later** — capture generously (stack trace, context,
  ids) at write time since you can't go back and add detail to a past event;
  filter and summarize at read time instead.
