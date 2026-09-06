# centralized-logging

A two-part system so you stop opening DevTools and stop SSH-ing into a
server just to figure out what broke. No cloud account, no signup, no
service that pauses itself after a quiet week — the whole backend is one
Python file storing logs in a local SQLite database on your own machine.

```
┌─────────────────────┐         ┌──────────────────────┐
│   Your backend app    │  HTTP   │                        │
│  (any language)        │ ─────► │                        │
└─────────────────────┘         │      server.py         │
                                  │  (stdlib Python)        │
┌─────────────────────┐         │  stores everything in   │
│  Chrome extension       │  HTTP   │      logs.db             │
│  (chrome-debug-logger)  │ ─────► │                        │
└─────────┬───────────┘         └───────────┬──────────┘
          │  live console/network              │
          │  view, right in the                │  HTTP
          │  browser, no server needed         ▼
          │                              ┌──────────────┐
          └─────────────────────────────►│ query_logs.py│◄── you / Claude ask it
                                          │   (the CLI)   │    "what broke?"
                                          └──────────────┘
```

---

## Table of contents

- [What each piece actually does](#what-each-piece-actually-does)
- [How the extension and server work together](#how-the-extension-and-server-work-together)
- [Integrating into an existing project — step by step](#integrating-into-an-existing-project--step-by-step)
- [Day-to-day usage](#day-to-day-usage)
- [Troubleshooting](#troubleshooting)
- [Limitations, stated plainly](#limitations-stated-plainly)

---

## What each piece actually does

| Piece | What it is | Runs where |
|---|---|---|
| `centralized-logging/scripts/server.py` | A tiny HTTP server + SQLite database, one file, Python standard library only | Your machine, in a terminal you leave open |
| `centralized-logging/scripts/logger_client.py` / `.js` | A drop-in logging client for your backend app | Inside your backend app's process |
| `centralized-logging/scripts/query_logs.py` | The CLI you (or Claude) run to actually look at what happened | Your terminal, on demand |
| `chrome-debug-logger/` | A Chrome extension that watches sites you allow | Your browser |

Nothing here is a cloud service. `server.py` listening on
`http://127.0.0.1:4317` **is** the "centralized" part — it's the one thing
both your backend and your browser can send data to, since they otherwise
have no way to talk to each other.

---

## How the extension and server work together

This is the part worth understanding properly, because it's not just
"extension sends everything to server" — it's deliberately split into two
paths so you get maximum visibility in the browser without flooding the
backend database with noise.

### Path 1 — the local viewer (extension only, server not required)

The extension attaches to an allowlisted tab using the same **Chrome
DevTools Protocol** that Chrome's own inspector uses. This catches:

- every `console.log/warn/error/debug` call
- uncaught exceptions and unhandled promise rejections
- browser-level log entries (CORS errors, deprecation warnings)
- **every single network request and response**, successful or not

All of this gets kept in an in-memory buffer inside the extension (last
500 events per tab). Click the extension icon → **Open full log viewer**
and you get a live, filterable, DevTools-Network-tab-style feed of
everything — with a **Copy visible logs** button that builds a clean text
block for pasting into any LLM. This path works even if `server.py` isn't
running at all.

### Path 2 — forwarding to the backend (needs `server.py` running)

Sending literally everything (including every successful `200 OK`) to the
backend database would drown out the errors that actually matter. So only
the meaningful subset gets forwarded to `server.py`'s `/logs` endpoint:

| Captured everywhere (Path 1) | Also forwarded to the server (Path 2) |
|---|---|
| ✅ console.log / info | ❌ not forwarded — too routine |
| ✅ console.warn / error | ✅ forwarded |
| ✅ uncaught exceptions | ✅ forwarded |
| ✅ browser log entries | ✅ forwarded |
| ✅ every network request | ❌ not forwarded — high volume, rarely useful after the fact |
| ✅ successful (2xx) responses | ❌ not forwarded |
| ✅ failed (4xx/5xx) responses | ✅ forwarded |

This is why the two paths exist separately: the **viewer** is for "let me
see everything happening right now," and the **backend** is for "let me
search/trace/group this later, alongside my server's own logs."

### The two-way link

Once both are running, three extra things become possible:

1. **Same fingerprint logic everywhere.** Both the extension and your
   backend loggers hash `error_type + message-with-numbers-stripped` the
   same way, so `query_logs.py groups` can show you "this exact bug
   happened 40 times across your backend AND your frontend" as one entry,
   not eighty.
2. **The popup reads back from the server.** Click the extension icon and
   it shows the last few backend-confirmed errors for whatever site you're
   on, pulled live from `server.py`.
3. **Claude can send the extension commands.** `query_logs.py command
   --action localstorage_snapshot --app myapp.com` writes a row into a
   small command queue in `logs.db`; the extension polls that queue every
   ~30 seconds, executes the command (grab localStorage, flush its queue,
   attach/detach a tab), and writes the result back — so debugging can
   happen without you touching the browser at all.

---

## Integrating into an existing project — step by step

### Step 1 — Get the files into your project

```bash
git clone https://github.com/kashyapgithub/centralized-logging.git
```

You don't need to merge this into your existing repo — it's fine sitting
as a sibling folder. Just note the path to `centralized-logging/scripts/`
for the steps below.

### Step 2 — Start the server

```bash
cd centralized-logging/scripts
python3 server.py
```

Leave this running in its own terminal tab (see the note on backgrounding
it below if you'd rather not dedicate a tab to it). Confirm it's alive:

```bash
curl http://127.0.0.1:4317/
# {"ok": true, "db": "/path/to/logs.db"}
```

### Step 3 — Wire your backend app to it

**If your backend is Node.js:**

```bash
cp centralized-logging/scripts/logger_client.js  your-project/src/logger_client.js
```

```js
const { CentralLogger } = require('./logger_client');
const logger = new CentralLogger({ appName: 'your-app-name' });

// wherever you currently have a try/catch or an error middleware:
logger.error(err, { context: { userId, route: req.path } });

// catch what nothing else catches:
process.on('uncaughtException', (err) => logger.fatal(err));
process.on('unhandledRejection', (err) => logger.fatal(err));
```

**If your backend is Python:**

```bash
cp centralized-logging/scripts/logger_client.py  your_project/logger_client.py
```

```python
from logger_client import CentralLogger
logger = CentralLogger(app_name="your-app-name")

try:
    do_the_thing()
except Exception:
    logger.exception("do_the_thing failed", context={"user_id": user_id})
```

**Any other language** (Go, PHP, Ruby, Java, whatever): there's no bundled
client, but it's one HTTP call:

```bash
curl -X POST http://127.0.0.1:4317/logs \
  -H "Content-Type: application/json" \
  -d '{"app_name": "your-app-name", "level": "error", "message": "it broke"}'
```

See `centralized-logging/references/client-integration.md` for fuller
examples per language.

**The important part isn't the library — it's *where* you call it.** Find
your app's global error handler (or add one) and log from there, so a
crash gets recorded automatically instead of only where someone remembered
to add a log line.

### Step 4 — Load the Chrome extension

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `chrome-debug-logger` folder
3. Click the extension icon → **Settings**
4. Confirm the server URL matches (`http://127.0.0.1:4317` by default)
5. Add the domain(s) you're actually developing, e.g. `localhost:3000`,
   `myapp.com` — it will not touch any other site

Reload a tab on one of those domains — you'll see Chrome's yellow "being
debugged" banner appear, confirming it attached.

### Step 5 — Confirm the whole loop works

Trigger an error in your backend (or the frontend), then:

```bash
python3 centralized-logging/scripts/query_logs.py recent --app your-app-name --minutes 5
```

You should see it. If not, check the [Troubleshooting](#troubleshooting)
section below.

---

## Day-to-day usage

```bash
# what's broken right now, across an app
python3 query_logs.py recent --app your-app-name --level error --minutes 60

# same bug happening over and over? see it as ONE entry, not a flood
python3 query_logs.py groups --app your-app-name

# follow one request across every log line it produced
python3 query_logs.py trace --request-id req_abc123

# watch it live while you reproduce something
python3 query_logs.py tail --app your-app-name

# mark something fixed so it stops showing as open
python3 query_logs.py resolve --fingerprint a1b2c3d4 --note "fixed in v1.2"
```

For frontend debugging, click the extension icon → **Open full log
viewer**, filter to what you care about, hit **Copy visible logs**, and
paste directly into a chat with an LLM.

Or — the intended shortcut — just tell me (Claude) what broke and which
app, and I'll run the CLI myself instead of you typing commands.

---

## Troubleshooting

**`query_logs.py` says "Couldn't reach the log server"**
`server.py` isn't running, or is running on a different port. Start it, or
set `LOG_SERVER_URL` to match wherever it's actually listening.

**Nothing shows up after triggering an error**
- Backend: confirm the logger's `serverUrl`/`server_url` matches where
  `server.py` is actually listening (default `http://127.0.0.1:4317`).
- Extension: confirm the domain is in the allowlist (Settings page) and
  that you reloaded the tab *after* adding it — it attaches on next
  navigation, not retroactively.
- Either way: check the extension only forwards `warn`/`error`/`fatal` to
  the backend by design (see the table above) — a plain `console.log`
  won't show up in `query_logs.py`, only in the extension's own viewer.

**The extension's "being debugged" banner won't go away / tab won't attach**
Only one thing can hold Chrome's debugger on a tab at a time. If DevTools
is already open on that tab, or another extension is debugging it, this
extension can't also attach.

**Commands sent via `query_logs.py command` time out**
The extension polls for commands roughly every 30 seconds — give it a
moment. Also confirm the extension is actually loaded and a Chrome window
is open (a suspended/closed browser can't poll anything).

---

## Limitations, stated plainly

- **Single machine by design.** Your backend, `server.py`, and your
  browser all need to reach each other over the network. Great for local
  dev; a backend deployed elsewhere (Railway, a VPS, etc.) can't reach a
  server running on your laptop unless you expose it deliberately.
- **`server.py` has to actually be running** for anything to persist.
  The extension's local viewer works without it; nothing else does.
- **The in-memory buffer isn't durable.** Extension reload or tab close
  wipes that tab's local log history. Only what got forwarded to
  `server.py` survives — that's what the backend half is for.
- **No built-in retention/pruning.** Log rows are tiny text, so this
  rarely matters, but see `references/database-schema.md` for a one-line
  SQL delete if `logs.db` ever grows large enough to care about.
