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
- [How the data is stored](#how-the-data-is-stored)
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
backend database would drown out the errors that actually matter. So by
default, only a meaningful subset gets forwarded to `server.py`'s `/logs`
endpoint — and you can change these defaults yourself, per category, from
the extension's popup (no options-page digging required):

| Captured everywhere (Path 1) | Forwarded to the server by default (Path 2) |
|---|---|
| ✅ all console output (log/info/warn/error/debug) | ✅ forwarded |
| ✅ uncaught exceptions | ✅ forwarded |
| ✅ browser log entries | ✅ forwarded |
| ✅ every raw network request | ❌ not forwarded — high volume, rarely useful after the fact |
| ✅ successful (2xx/3xx) responses | ❌ not forwarded |
| ✅ failed (4xx/5xx) responses | ✅ forwarded |

**Choosing what gets forwarded:** click the extension icon — there's a
"Send to backend server" section with a checkbox per category (Console
output, Uncaught exceptions, Browser log entries, Network failures, All
raw network traffic). Toggling one takes effect immediately, on the very
next captured event — no save button, no reload. Turning **everything**
off just means you're using this purely as the local copy-paste viewer
(Path 1 still works exactly the same); turning **raw network traffic** on
means literally every request/response, including 200s, starts landing in
`logs.db` too — useful for a deep one-off investigation, noisy to leave on
permanently.

This is why the two paths exist separately: the **viewer** is for "let me
see everything happening right now," and the **backend** is for "let me
search/trace/group this later, alongside my server's own logs" — and the
popup toggle is what lets you decide, category by category, which things
graduate from the first list to the second.

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

### How reliable is the log stream, actually

Worth being upfront about, since "centralized logging" can sound more
bulletproof than a single-file, single-process tool can honestly promise.

**Extension → local buffer (Path 1, the viewer):** effectively instant —
it's capturing DevTools protocol events straight into memory in the same
process. Reliable by construction, not much to caveat.

**Extension → `server.py` (Path 2, backend forwarding):** best-effort, not
guaranteed:

- **Batching, not instant.** A send happens when either 50 events queue up
  or a periodic alarm fires (~30s in dev/unpacked mode; Chrome enforces a
  1-minute floor once packed). Busy tabs flush almost immediately; quiet
  tabs can sit queued for up to that interval.
- **No retry, no persistence.** If `server.py` isn't running when a flush
  happens, or the request just fails, that batch is silently dropped —
  there's no on-disk retry queue. This is deliberate: fire-and-forget,
  kept simple, matching the "one Python file, no dependencies" goal.
- **Service worker suspension.** Chrome can suspend the extension's
  background process when idle. If that happens before a flush, whatever
  was queued in memory at that instant is lost. This mainly bites sparse,
  occasional events — a page erroring continuously will flush well before
  it matters.

**Practical takeaway:** treat this as excellent visibility while you're
actively debugging, not a guaranteed audit trail. If one specific event
absolutely must not be lost, the local viewer (Path 1) is the more
trustworthy read for that exact moment, since it isn't subject to a
network hop at all — the backend side is for pattern-spotting and history
across a session, not for guaranteeing capture of every single event.

## How the data is stored

Nothing exotic — `server.py` uses Python's built-in `sqlite3` module to
write into one file, `logs.db`, sitting next to `server.py` by default
(override the location with `LOG_DB_PATH`).

- Two tables: `logs` (every event) and `commands` (the extension's command
  queue) — see `references/database-schema.md` for the full column layout.
- `context` and `tags` are stored as JSON *text* inside each row (SQLite
  has no native JSON column type) — the server decodes them back into real
  objects in every API response, so you never see raw JSON strings when
  querying through the CLI.
- It's a single file, so you can inspect it directly with any SQLite tool
  without going through the CLI at all:
  ```bash
  sqlite3 logs.db "select created_at, app_name, level, message from logs order by created_at desc limit 5;"
  ```
  or open it in a GUI browser like "DB Browser for SQLite" if you'd rather
  click around than type SQL.
- SQLite handles concurrent writes via file-level locking — fine for one
  or a handful of apps logging at normal rates. It's not built for
  high-throughput concurrent writes from dozens of processes at once, but
  that's not the scenario this tool is meant for.
- No encryption, no access control beyond "who can reach `127.0.0.1:4317`"
  — appropriate for a local dev tool, not for anything containing real
  secrets or production PII. Keep that in mind for what you put in a log's
  `context` field.

## Integrating into an existing project — step by step

### Step 1 — Get the files (anywhere — this is not a per-project install)

```bash
git clone https://github.com/kashyapgithub/centralized-logging.git
```

**Where you clone this doesn't matter, and it does not need to live inside
any particular project's folder.** `server.py` has no concept of "which
project this is" — it's just an HTTP server. You can clone it once,
somewhere central on your machine (`~/tools/centralized-logging`, your
Desktop, wherever), run one server, and point every project you work on at
it — they're told apart by the `app_name` you give each one, not by
folder location. See [How this scales across multiple projects](#how-this-scales-across-multiple-projects)
below.

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

### How this scales across multiple projects

You do **not** need a separate `server.py` per project. The intended
setup is:

- **One server, running once**, anywhere on your machine (see Step 1 —
  it's not tied to any project folder).
- **Every project gets its own `app_name`** when it creates its logger —
  that's the only thing that tells them apart:
  ```python
  logger = CentralLogger(app_name="project-abc")
  ```
  ```js
  const logger = new CentralLogger({ appName: 'project-xyz' });
  ```
- All of it lands in the same `logs.db`. Every CLI command and the
  extension's own views filter by `--app`/`app_name`, so working on
  project ABC never shows you noise from project XYZ — they're in the same
  file, but never mixed in what you actually see.

If you genuinely want full physical separation (a different file per
project, not just a different name in the same file), run a second server
with a different port and DB path:

```bash
LOG_SERVER_PORT=4318 LOG_DB_PATH=./xyz-logs.db python3 server.py
```

and point that project's logger at `http://127.0.0.1:4318` instead. Most
people won't need this — one server, many `app_name`s, is simpler and is
the default assumption throughout the rest of this README.

### Categorizing the Chrome extension's logs by project

The backend side above is `app_name` you set in code. The **browser** side
works the same way, but you set it once in the extension's Settings
instead of in code — each allowlist entry is a **domain** to capture, and a
**label** that becomes `app_name` for everything captured from it:

| Domain you allowlist | Label you give it | Result |
|---|---|---|
| `localhost:3000` | `project-abc` | Every log from that port shows up as `app_name: "project-abc"` |
| `localhost:4000` | `project-xyz` | Same server, same `logs.db`, completely separate from ABC |
| `myapp.com` | `myapp-prod` | Covers `myapp.com` and any subdomain (`app.myapp.com`, etc.) |

**This is also the fix for a real gotcha with two local projects:** if you
just allowlisted `localhost` for two different projects both running
locally, they'd collide — a plain hostname match doesn't see the port, so
both would report as the same app. Including the port in the domain
(`localhost:3000` vs `localhost:4000`) is what tells them apart; the label
is what makes the result readable instead of you having to remember which
port was which project.

Once labeled, everything downstream just works with that name:
`query_logs.py recent --app project-abc`, the log viewer's project
dropdown, the popup's "recent errors" panel — all keyed off the label, not
the raw domain.

Set this via the extension's popup → Settings, or for an agent-driven
setup, in `config.local.json`'s `allowlist` array (see
`config.example.json` for the exact shape).

---

## Day-to-day usage

**You often don't even need the CLI to copy something out.** The terminal
running `server.py` prints every incoming log as a clearly delimited
block the moment it arrives:

```
========================================================================
[2026-09-06T13:14:37+00:00]  project-abc  —  ERROR
------------------------------------------------------------------------
message      : payment failed for user 42
error_type   : PaymentError
fingerprint  : fp1
request_id   : req_789
context      : {"order_id": "ord_123"}
stack_trace  :
  Traceback (most recent call last):
    File "app.py", line 12, in charge
      raise PaymentError()
  PaymentError: card declined
========================================================================
```

Just select a block (or several) straight out of that terminal and paste
it into any AI chat — no reformatting needed. Set `LOG_SERVER_QUIET=1`
before starting the server if you'd rather it stay silent and only use
`query_logs.py` to look things up on demand.

For pulling specific things back out later:

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
