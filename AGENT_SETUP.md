# Setup instructions — for an agent

This file is written to be handed to a coding agent (Claude Code, Cursor,
etc.) sitting in a terminal with this repo cloned, not to be read by a human
clicking through a UI.

There's no account or cloud project anywhere in this system — the backend
is one Python script. That means almost everything below is scriptable.
Only the very last step (loading the extension into Chrome) is genuinely
manual.

## Step 1 — Start the log server

```bash
python3 centralized-logging/scripts/server.py &
```

Standard library only — no `pip install` needed. It listens on
`127.0.0.1:4317` by default and creates `logs.db` next to itself on first
run. Confirm it's up:

```bash
curl http://127.0.0.1:4317/
# {"ok": true, "db": "/path/to/logs.db"}
```

Override the port/host/db path with `LOG_SERVER_PORT`, `LOG_SERVER_HOST`,
or `LOG_DB_PATH` if the human needs something other than the default.

## Step 2 — Wire the backend app

This part is genuinely code-editing, not scriptable in general, since it
depends entirely on the target app's structure. Do this yourself, directly:

1. If the app is Node or Python, copy the matching file from
   `centralized-logging/scripts/logger_client.{js,py}` into the project and
   import it. Both default to `http://127.0.0.1:4317` — only pass
   `serverUrl`/`server_url` explicitly if the server runs somewhere else.
2. For any other language, follow `centralized-logging/references/client-integration.md`
   — it's a plain HTTP POST, implement it with whatever HTTP client that
   language already uses.
3. Find the app's global error handler / uncaught-exception hook (or add
   one if it doesn't have one) and call the logger from there, so crashes
   get logged automatically rather than only where a developer remembered
   a log line.

## Step 3 — Configure the Chrome extension without touching its UI

```bash
cp chrome-debug-logger/config.example.json chrome-debug-logger/config.local.json
```

Edit `config.local.json`:

```json
{
  "serverUrl": "http://127.0.0.1:4317",
  "allowlist": ["localhost", "the-humans-actual-domain.com"]
}
```

`config.local.json` is gitignored — the extension reads it once on startup
and seeds its settings from it automatically, but only if nothing has been
set yet (it never overwrites values the human already entered by hand in
the Settings page).

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
check in this order: is the server actually running (`curl http://127.0.0.1:4317/`)?
Is `config.local.json` filled in correctly? Did the tab actually get the
"being debugged" banner?
