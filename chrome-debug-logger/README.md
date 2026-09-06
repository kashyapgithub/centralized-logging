# Central Log Capture (Chrome extension)

Captures console output, uncaught exceptions, and failed network requests
from sites you choose — into the same local log server used by the
[`centralized-logging`](../centralized-logging) skill. Instead of opening
DevTools every time something breaks on a site you're building, you (or the
agent) can just run `query_logs.py recent --app <hostname>`.

No cloud account anywhere in this — the "backend" is one Python script
(`centralized-logging/scripts/server.py`) running on your own machine.

## How it works

Rather than injecting a script that overrides `window.console` (which a page
can detect or override right back), this uses the same **Chrome DevTools
Protocol** DevTools itself is built on (`chrome.debugger`). That's what lets
it also catch failed network requests, not just console lines — the
trade-off is Chrome shows a **"Central Log Capture is debugging this
browser"** banner on any tab it's attached to. That's expected, not a bug.

## Why there's an allowlist

`chrome.debugger` can see everything happening on a page, including
`localStorage` — which is exactly what makes it useful for debugging your
own app (auth tokens, cached state, whatever explains the bug), and exactly
why it must never run on sites you didn't explicitly add. It does **not**
run on any site by default. Add domains in the extension's Settings page.

## Install

**Agent-driven setup:** see `AGENT_SETUP.md` at the repo root — a coding
agent can start the server and write `config.local.json` for you. Only one
step is genuinely manual: loading the extension into Chrome itself.

**Manual setup:**

1. Start the log server: `python3 centralized-logging/scripts/server.py`
   (defaults to `http://127.0.0.1:4317`, no account needed).
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**, select this `chrome-debug-logger` folder
5. Click the extension's icon → **Settings**:
   - Confirm the server URL matches what `server.py` printed on startup
   - Add the domain(s) you want captured, e.g. `localhost`, `myapp.com`

Tip: instead of typing into Settings, copy `config.example.json` to
`config.local.json` and fill in real values — the extension picks it up
automatically on next load. `config.local.json` is gitignored.

## What gets logged

| Source | Captured as |
|---|---|
| `console.log/info/warn/error/debug` | matching `level`, with args joined into `message` |
| Uncaught exceptions / unhandled rejections | `level: error`, full stack trace, `error_type` from the exception class |
| Browser-level log entries (CORS errors, deprecations, etc.) | `level` mapped from Chrome's own severity |
| Failed or 4xx/5xx network responses | `level: warn` (4xx) or `error` (5xx), with status + URL in `context` |

Every row also gets `app_name` = the site's hostname and
`environment: "browser"`, so it sits in the same log server as your backend
logs without colliding with them.

`localStorage` is only snapshotted and attached to `context.local_storage`
for actual errors — not on every console line — to avoid scraping it
continuously.

## Choosing what gets forwarded to the backend

Every one of the sources above is always captured into the local viewer,
full stop. Which of them *also* get forwarded to `server.py` is up to
you: click the extension icon and there's a **"Send to backend server"**
section with a checkbox per category —

- Console output
- Uncaught exceptions
- Browser log entries
- Network failures (4xx/5xx)
- All raw network traffic (off by default — noisy)

Toggling any of these applies immediately to the next captured event, no
save button and no reload needed. This never affects the local viewer —
turning everything off just means you're using the extension purely as a
copy-paste tool with nothing persisted to `logs.db`.

An agent (or you) can also preset these via `config.local.json`'s
`forwardConfig` object instead of clicking checkboxes — see
`config.example.json` for the shape.

## Reading logs without any setup — the viewer

Click the extension icon → **Open full log viewer**. This opens a page that
reads straight from the in-memory buffer this extension already keeps per
tab — **it works even if the log server isn't running**, live, for whatever
allowlisted site you have open:

- Pick the site from the dropdown at the top.
- Filter by type — console, exceptions, browser-level log entries, network
  responses/failures, and (off by default, since it's high-volume) every
  raw outgoing request, DevTools-Network-tab style.
- **Copy visible logs** builds a plain-text block of whatever's currently
  shown and puts it on your clipboard — paste it straight into ChatGPT,
  Claude, or any other assistant to get help with what broke.
- **Clear** wipes that tab's buffer (doesn't touch anything already sent to
  the log server).

This buffer is intentionally separate from what gets forwarded to the
backend: console output, exceptions, and browser log entries always get
sent to the log server (if it's running); network responses/failures only
get sent if they're actual problems (4xx/5xx or failed); but *everything*,
including successful 200s and raw outgoing requests, shows up in this local
viewer. The buffer holds the last 500 events per tab and resets if the tab
closes or the extension reloads — it's a debugging aid, not a persistent
record (that's what the log server's `logs.db` is for).

## Talking to Claude / query_logs.py

Two things this extension can do beyond passive logging:

1. **The popup reads back recent errors** for whatever site you're
   currently on, straight from the log server — no need to run the CLI
   just to eyeball what's broken.
2. **Claude can send this extension live commands** via
   `python3 query_logs.py command --action <action> --app <hostname>`:
   - `status` — which hostnames are currently attached
   - `flush` — send whatever's queued right now instead of waiting
   - `attach` / `detach` — start/stop capturing a specific open tab
   - `localstorage_snapshot` — grab that tab's localStorage on demand

   This works by polling: the extension checks the server's command queue
   roughly every 30 seconds (in dev/unpacked mode) and executes anything
   pending, so there can be a short delay between issuing a command and
   seeing the result — the CLI polls for you and prints the result once it
   lands.

## Known limitations

- **The log server must be running** for anything to reach the backend —
  if it's not, the popup's "recent errors" and any command you send will
  just fail quietly (the console log viewer still works regardless, since
  it's fully local to the extension).
- **Service worker suspension**: Chrome can suspend the extension's
  background service worker when idle. Queued-but-unsent logs from a quiet
  tab can be lost if that happens before the once-a-minute flush alarm
  fires. Busy tabs flush as soon as 50 events queue up, so this mostly
  affects sparse, occasional errors — not a big deal for a debugging tool,
  but don't treat this as an audit-grade log.
- **One attacher per tab**: if DevTools is already open on a tab, or another
  extension has already attached its debugger, this extension can't also
  attach — it'll skip that tab silently (check the extension's own console
  via `chrome://extensions` → "service worker" link if a tab isn't showing
  up as captured).
