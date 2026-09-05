# Server & Schema Reference — `server.py`

This is the reference for what `server.py` stores and how to talk to it.
Read this before wiring up a new client, or before explaining the design to
the user.

## Why a local server instead of a hosted database

The whole point of this version is **no external dependency**: no account,
no cloud project to configure, nothing that pauses itself after a quiet
week. `server.py` is Python standard library only — no `pip install` — and
stores everything in one SQLite file next to it (`logs.db` by default).

The trade-off, stated plainly: everything that needs to write logs must be
able to reach this process over the network. For a solo dev's local
machine — backend running locally, browser on the same machine — that's a
non-issue. If a backend app is deployed elsewhere (Railway, a VPS, etc.),
it can't reach a server running on your laptop unless you expose it
somehow (a tunnel, or running the server on a reachable host instead of
`127.0.0.1`). Don't over-engineer around this unless the user actually asks
for multi-machine reach — the default is local-only, on purpose.

## Running it

```bash
python3 server.py                        # 127.0.0.1:4317, logs.db next to server.py
LOG_DB_PATH=/tmp/mylogs.db python3 server.py
LOG_SERVER_PORT=5000 python3 server.py
LOG_SERVER_HOST=0.0.0.0 python3 server.py  # reachable from other machines on the network
```

It needs to be running whenever something is actively logging or being
queried — there's no daemon/service setup here by default. For "always
on" during a work session, just leave it running in a terminal, or use
`nohup python3 server.py &` / a simple systemd user unit if the user wants
it persistent across reboots.

## Table: `logs`

| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `created_at` | `TEXT` (ISO 8601, UTC) | Set by the server on insert — clients don't send this. |
| `app_name` | `TEXT` | Which application logged this. One server can serve many apps — this is what tells them apart. |
| `environment` | `TEXT` | `development` / `staging` / `production`. |
| `level` | `TEXT` | `debug`, `info`, `warn`, `error`, `fatal` — not enforced by the DB (SQLite has no CHECK-by-default here), so validate client-side if it matters. |
| `message` | `TEXT` | Keep variable parts (ids, values) out of this — that's what makes fingerprinting work. |
| `error_type` | `TEXT` | Exception/class name, if this came from a caught error. |
| `stack_trace` | `TEXT` | Full trace, uncut. |
| `context` | `TEXT`, JSON-encoded | Anything else — request payload, feature flags, retry count. Decoded back to an object in every API response. |
| `fingerprint` | `TEXT` | Computed client-side: hash of `error_type + message-with-digits-stripped`. Groups repeats of the same bug. |
| `source_file` / `source_line` / `source_function` | | Where in the code this fired, if known. |
| `request_id` / `session_id` | `TEXT` | Correlates every log line from one request or session. |
| `user_ref` | `TEXT` | The app's own identifier for who was affected — not PII, just something the app can look up. |
| `tags` | `TEXT`, JSON-encoded array | Free-form labels. |
| `duration_ms` | `REAL` | Optional, for perf-flavored events. |
| `resolved` / `resolved_at` / `resolved_note` | | Set via `PATCH /logs/resolve`. |

## Table: `commands`

Backs the chrome-debug-logger extension's two-way link — see
`chrome-debug-logger/lib/commands.js`. A trusted client (`query_logs.py
command`) inserts a row; the extension polls `/commands/pending`, acts on
it, and `PATCH`es back a status + result.

## HTTP API

All bodies/responses are JSON. CORS is wide open (`Access-Control-Allow-Origin: *`)
since this only ever runs on `localhost` for a single user — that's fine
here in a way it would not be for a public-facing server.

| Method & path | Purpose |
|---|---|
| `GET /` | Health check — `{"ok": true, "db": "<path>"}` |
| `POST /logs` | Insert one row (JSON object) or many (JSON array) |
| `GET /logs/recent?app=&level=&minutes=&limit=` | Most recent rows. `level` accepts a comma-separated list. |
| `GET /logs/groups?app=&unresolved_only=&limit=` | Distinct problems grouped by `fingerprint`, most recent first |
| `GET /logs/trace?request_id=` or `?session_id=` | Every row sharing that id, oldest first |
| `GET /logs/tail?app=&level=&since=` | Rows created after the given ISO timestamp — what `query_logs.py tail` polls |
| `PATCH /logs/resolve?fingerprint=` body `{"note": "..."}` | Marks every row with that fingerprint resolved |
| `POST /commands` body `{"app_name": "...", "command": "...", "payload": {}}` | Issue a command for the extension |
| `GET /commands/pending` | What the extension polls |
| `GET /commands/<id>` | What `query_logs.py command` polls for the result |
| `PATCH /commands/<id>` body `{"status": "...", "result": {...}}` | Extension reports back |

## Fingerprinting

Computed **client-side** (in the logger, not the server) as a hash of
`error_type + message-with-variables-stripped` — e.g.
`sha256(error_type + ":" + re.sub(r'\d+', '#', message))[:16]`. Both
`logger_client.py`/`.js` and the extension's `fingerprint.js` do this the
same way, so the same underlying bug groups together in `/logs/groups`
regardless of which client logged it.

## Retention

There's no automatic pruning — it's a local file, and log rows are tiny
(no images/files, just text + small JSON). If it ever grows large enough
to matter, the fix is a one-line SQL delete against `logs.db` directly:

```sql
DELETE FROM logs
WHERE (level IN ('debug','info') AND created_at < datetime('now', '-30 days'))
   OR (level IN ('warn','error','fatal') AND created_at < datetime('now', '-90 days'));
```

Run that with `sqlite3 logs.db "<query>"` — don't automate it silently,
mention it to the user and let them decide when.
