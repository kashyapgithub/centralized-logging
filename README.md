# centralized-logging

Two-part system for tracking what went wrong in an app, without living in
DevTools or SSH-ing into a server to tail logs.

- **`centralized-logging/`** — a Claude Skill. Any backend app (any
  language) writes structured error/event rows into one Supabase/Postgres
  table (`app_logs`). Ships with a query CLI (`scripts/query_logs.py`) for
  searching, grouping repeat errors by fingerprint, tracing a request end to
  end, tailing live, and sending commands to the browser extension below.

- **`chrome-debug-logger/`** — a Chrome extension (Manifest V3). Captures
  console output, uncaught exceptions, and network activity from sites you
  allowlist, using the Chrome DevTools Protocol. Has a built-in live viewer
  (open via the popup) with a "Copy visible logs" button for pasting
  straight into any LLM — no Supabase setup required for that part. It can
  also optionally forward real problems to the same `app_logs` table as the
  backend skill, and receive live commands from `query_logs.py`.

See the README/SKILL.md inside each folder for setup instructions.
