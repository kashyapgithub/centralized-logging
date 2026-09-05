---
name: centralized-logging
description: >
  Set up centralized, queryable error/event logging for ANY application (any
  language — Node, Python, Go, PHP, mobile, browser, etc.) backed by a
  single local SQLite server — no cloud account, no signup — and use it to
  actively debug issues. Trigger this skill whenever the user asks to "add
  logging", "set up centralized logging", "track errors", "log everything
  to a database", "debug what went wrong", "why did my app crash / fail",
  "check the error logs", or wants a single place to see every error/event
  across one or more apps. Also trigger when the user pastes an error/stack
  trace and asks you to investigate — use the query CLI here to search
  stored logs for related occurrences before guessing. Covers the local log
  server, write-side client snippets per language, and read-side CLI tools
  for the agent to search, group, and tail logs.
---

# Centralized Logging

A drop-in, language-agnostic logging system: every app writes structured
log/error events into one local SQLite database, over plain HTTP, via a
single Python script with **zero external dependencies** — no cloud
account, no signup, nothing that pauses itself after a quiet week.

Three pieces:

1. **The server** (`scripts/server.py`) — run it, it listens on
   `127.0.0.1:4317` and stores everything in `logs.db` next to it.
2. **Write side** — get events *into* it from whatever app the user is
   building (any language).
3. **Read side** — `scripts/query_logs.py`, which you run yourself to
   search, group, and tail those events when debugging.

## The trade-off, stated up front

Everything that writes or reads logs has to reach this server over the
network. On one machine (backend running locally, browser on the same
machine) that's a non-issue — this is the common case and the default
assumption throughout this skill. If a backend gets deployed somewhere
else (Railway, a VPS, etc.), it can't reach a server running on the user's
laptop unless they expose it deliberately. Don't build around this unless
the user actually asks for multi-machine reach — keep it local by default.

## Bundled resources — read these before building

| File | When to open it |
|---|---|
| `references/database-schema.md` | Always, first. Table layout, the full HTTP API `server.py` exposes, and the fingerprinting/retention approach. |
| `references/client-integration.md` | When wiring a specific app up to write logs. Generic HTTP/cURL recipe (any language) plus ready snippets for Node.js, Python, Go, and browser JS. |
| `scripts/server.py` | The whole backend. Read it if you need to add an endpoint or change the schema — it's one file, stdlib only. |
| `scripts/logger_client.py` / `.js` | Copyable, batched loggers for Python/Node apps. |
| `scripts/query_logs.py` | The agent's debugging CLI — search, group-by-fingerprint, tail, mark-resolved, and send live commands to the chrome-debug-logger extension. |

Don't paste the full contents of every reference file into your response to
the user — read what you need, then act.

## Workflow

### 1. Start the server

```bash
python3 scripts/server.py
```

That's the entire "provisioning" step — no account, no project creation, no
web dashboard. It needs to be running whenever something is actively
logging or being queried; for a work session, just leave it running in a
terminal (or `nohup python3 scripts/server.py &` for something longer-lived).

### 2. Wire up the app to write logs

- Read `references/client-integration.md`.
- Node.js or Python → copy the matching `scripts/logger_client.*` into the
  project and adapt `appName`/`app_name` and log calls to the app's actual
  entry points, error handlers, and request middleware.
- Any other language → follow the generic HTTP/cURL pattern in that same
  file — it's a plain JSON POST, no auth headers.
- Capture real detail, not just a message: exception type, full stack
  trace, request id, environment, and a free-form `context` object for
  anything app-specific. The point is that every little detail needed to
  reconstruct the failure is in one row.
- Wrap this in the app's global error handler / uncaught-exception hook so
  logging happens automatically, not only where a developer remembered to
  add a log line.

### 3. Debug with it

When the user reports something broke, or pastes an error, pull real data
instead of reasoning from the snippet alone:

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

# talk to the chrome-debug-logger extension directly, if it's set up
python3 scripts/query_logs.py command --action localstorage_snapshot --app <hostname>
python3 scripts/query_logs.py command --action flush
```

`query_logs.py` defaults to `http://127.0.0.1:4317` — set `LOG_SERVER_URL`
if the server is running somewhere else.

### 4. Housekeeping

Log rows are tiny text, so this rarely matters — but `references/database-schema.md`
has a one-line SQL delete for pruning old rows if `logs.db` ever grows
large enough to care about. Mention it, don't run it silently.

## Design principles this skill follows

- **One server, any app** — every row is tagged `app_name`, so one running
  server can back every local project the user builds, not just one.
- **Zero setup** — no account, no cloud project, no web dashboard to
  configure. `python3 scripts/server.py` is the entire provisioning step.
- **Fingerprinting over noise** — a hash of `error_type + normalized message`
  groups repeats of the same bug into one row in `groups`, so a loop that
  fails 400 times shows up as one thing to investigate, not 400.
- **Detail now, judgment later** — capture generously (stack trace,
  context, ids) at write time since you can't go back and add detail to a
  past event; filter and summarize at read time instead.
