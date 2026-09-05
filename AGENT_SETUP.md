# Setup instructions — for an agent

This file is written to be handed to a coding agent (Claude Code, Cursor,
etc.) sitting in a terminal with this repo cloned, not to be read by a human
clicking through a UI. It says exactly what to run and what to edit.

## What the human needs to provide first

There's no way around one fact: creating the Supabase project itself
requires a human to sign in via the browser at supabase.com (no API can
create an account or a project on someone's behalf without their login).
Ask the human for these three things before doing anything else:

- `SUPABASE_DB_URL` — Postgres connection string. Dashboard → Project
  Settings → Database → Connection string → URI.
- `SUPABASE_URL` — Dashboard → Project Settings → API → Project URL.
- `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_KEY` — same API settings page.

Everything below this point is scriptable — no web UI required.

## Step 1 — Apply the database schema

```bash
SUPABASE_DB_URL="<the connection string>" bash centralized-logging/scripts/setup.sh
```

Add `--with-remote-control` on the end if the human also wants the
extension's two-way link (popup read-back + live commands). That flag
applies `remote_control_schema.sql`, which widens the anon key from
insert-only to insert+read — read the comment at the top of that file and
mention the trade-off to the human before passing this flag by default.

Verify it worked: the script's own sanity check prints a row count from
`app_logs` at the end. If `psql` isn't installed, install it first
(`apt-get install postgresql-client` / `brew install libpq`, depending on
the environment) rather than skipping the step.

## Step 2 — Wire the backend app

This part is genuinely code-editing, not scriptable in general, since it
depends entirely on the target app's structure. Do this yourself, directly:

1. Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to the target app's env
   file / secrets config.
2. If the app is Node or Python, copy the matching file from
   `centralized-logging/scripts/logger_client.{js,py}` into the project and
   import it.
3. For any other language, follow `centralized-logging/references/client-integration.md`
   — it's a plain HTTP POST, implement it with whatever HTTP client that
   language already uses.
4. Find the app's global error handler / uncaught-exception hook (or add
   one if it doesn't have one) and call the logger from there, so crashes
   get logged automatically rather than only where a developer remembered
   a log line.

## Step 3 — Configure the Chrome extension without touching its UI

```bash
cp chrome-debug-logger/config.example.json chrome-debug-logger/config.local.json
```

Edit `config.local.json` and fill in the real values:

```json
{
  "supabaseUrl": "<SUPABASE_URL>",
  "supabaseAnonKey": "<SUPABASE_ANON_KEY>",
  "allowlist": ["localhost", "the-humans-actual-domain.com"]
}
```

`config.local.json` is gitignored — never commit it. The extension reads
this file once on startup and seeds its settings from it automatically, but
only if nothing has been set yet (it never overwrites values the human
already entered by hand in the Settings page).

## Step 4 — The one step that's actually manual

Tell the human, plainly, that this part needs their hands on their own
browser — no agent can click through a Chrome settings page on their
behalf:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, select the `chrome-debug-logger` folder
4. Reload a tab on one of the allowlisted domains — the extension should
   show it under "Currently capturing"

## Step 5 — Confirm it's working end to end

```bash
python3 centralized-logging/scripts/query_logs.py recent --app <hostname-or-backend-app-name> --minutes 5
```

If the human just reloaded an allowlisted tab or the backend app just
started, this should show at least one row. If it's empty after a minute,
walk through: is `config.local.json` filled in correctly? Did the tab
actually get the "being debugged" banner? Is `SUPABASE_SERVICE_KEY` set in
the shell running `query_logs.py`?
