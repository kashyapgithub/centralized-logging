#!/usr/bin/env python3
"""
server.py — the entire centralized-logging backend. One file, Python
standard library only (no pip install), storing everything in a local
SQLite file. This is what replaced the Supabase/Postgres version: no
account, no cloud project, nothing that pauses after a quiet week — just a
process and a file on your own machine.

Run it:
    python3 server.py                        # 127.0.0.1:4317, logs.db next to this file
    LOG_DB_PATH=/tmp/mylogs.db python3 server.py
    LOG_SERVER_PORT=5000 python3 server.py

Any app, any language, logs to it with a plain HTTP POST:
    curl -X POST http://127.0.0.1:4317/logs \
      -H "Content-Type: application/json" \
      -d '{"app_name": "my-app", "level": "error", "message": "boom"}'

The chrome-debug-logger extension and query_logs.py both talk to this same
server — that's what makes it "centralized": one file, three writers
(your backend, your browser, and you/Claude debugging it).
"""

import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DB_PATH = os.environ.get(
    "LOG_DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs.db")
)
PORT = int(os.environ.get("LOG_SERVER_PORT", "4317"))
HOST = os.environ.get("LOG_SERVER_HOST", "127.0.0.1")

SCHEMA = """
CREATE TABLE IF NOT EXISTS logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL,
    app_name        TEXT NOT NULL,
    environment     TEXT NOT NULL DEFAULT 'production',
    host            TEXT,
    level           TEXT NOT NULL DEFAULT 'info',
    message         TEXT NOT NULL,
    error_type      TEXT,
    stack_trace     TEXT,
    context         TEXT NOT NULL DEFAULT '{}',   -- JSON, stored as text (SQLite has no native JSON type)
    fingerprint     TEXT,
    source_file     TEXT,
    source_line     INTEGER,
    source_function TEXT,
    request_id      TEXT,
    session_id      TEXT,
    user_ref        TEXT,
    tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array, stored as text
    duration_ms     REAL,
    resolved        INTEGER NOT NULL DEFAULT 0,
    resolved_at     TEXT,
    resolved_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_app_time ON logs (app_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);
CREATE INDEX IF NOT EXISTS idx_logs_fingerprint ON logs (fingerprint);
CREATE INDEX IF NOT EXISTS idx_logs_request ON logs (request_id);

-- Command queue for the chrome-debug-logger extension's two-way link.
CREATE TABLE IF NOT EXISTS commands (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL,
    app_name      TEXT,
    command       TEXT NOT NULL,
    payload       TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending',
    result        TEXT,
    completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_pending ON commands (status);
"""


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row, json_fields=("context", "tags")):
    d = dict(row)
    for key in json_fields:
        if d.get(key) is not None:
            try:
                d[key] = json.loads(d[key])
            except (TypeError, json.JSONDecodeError):
                pass
    return d


class Handler(BaseHTTPRequestHandler):
    server_version = "CentralLogServer/1.0"

    def log_message(self, fmt, *args):
        pass  # keep stdout quiet; remove this override if you want request logs

    # -- low-level helpers ----------------------------------------------------

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return None
        return json.loads(self.rfile.read(length))

    def do_OPTIONS(self):
        # CORS preflight — lets the Chrome extension's fetch() through.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if parsed.path == "/":
                self._send_json(200, {"ok": True, "db": DB_PATH})
            elif parsed.path == "/logs/recent":
                self._handle_recent(params)
            elif parsed.path == "/logs/groups":
                self._handle_groups(params)
            elif parsed.path == "/logs/trace":
                self._handle_trace(params)
            elif parsed.path == "/logs/tail":
                self._handle_tail(params)
            elif parsed.path == "/commands/pending":
                self._handle_commands_pending()
            elif parsed.path.startswith("/commands/"):
                self._handle_command_get(parsed.path.rsplit("/", 1)[-1])
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as exc:  # a bug here must never crash the whole server
            self._send_json(500, {"error": str(exc)})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = self._read_json_body()
            if parsed.path == "/logs":
                self._handle_insert_logs(body)
            elif parsed.path == "/commands":
                self._handle_insert_command(body)
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_PATCH(self):
        parsed = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            body = self._read_json_body() or {}
            if parsed.path == "/logs/resolve":
                self._handle_resolve(params, body)
            elif parsed.path.startswith("/commands/"):
                self._handle_command_update(parsed.path.rsplit("/", 1)[-1], body)
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    # -- /logs ------------------------------------------------------------------

    def _handle_insert_logs(self, body):
        rows = body if isinstance(body, list) else [body]
        conn = get_db()
        conn.executemany(
            """INSERT INTO logs
               (created_at, app_name, environment, host, level, message, error_type,
                stack_trace, context, fingerprint, source_file, source_line,
                source_function, request_id, session_id, user_ref, tags, duration_ms)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (
                    now_iso(),
                    r.get("app_name", "unknown-app"),
                    r.get("environment", "production"),
                    r.get("host"),
                    r.get("level", "info"),
                    r.get("message", ""),
                    r.get("error_type"),
                    r.get("stack_trace"),
                    json.dumps(r.get("context", {})),
                    r.get("fingerprint"),
                    r.get("source_file"),
                    r.get("source_line"),
                    r.get("source_function"),
                    r.get("request_id"),
                    r.get("session_id"),
                    r.get("user_ref"),
                    json.dumps(r.get("tags", [])),
                    r.get("duration_ms"),
                )
                for r in rows
            ],
        )
        conn.commit()
        conn.close()
        self._send_json(200, {"inserted": len(rows)})

    def _handle_recent(self, params):
        app = params.get("app")
        minutes = int(params.get("minutes", 60))
        limit = int(params.get("limit", 50))
        since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()

        query = "SELECT * FROM logs WHERE created_at >= ?"
        args = [since]
        if app:
            query += " AND app_name = ?"
            args.append(app)
        if params.get("level"):
            levels = params["level"].split(",")
            query += f" AND level IN ({','.join('?' * len(levels))})"
            args.extend(levels)
        query += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)

        conn = get_db()
        rows = [row_to_dict(r) for r in conn.execute(query, args).fetchall()]
        conn.close()
        self._send_json(200, {"rows": rows})

    def _handle_groups(self, params):
        app = params.get("app")
        limit = int(params.get("limit", 20))

        query = """
            SELECT app_name, fingerprint, error_type, level,
                   COUNT(*) AS occurrences,
                   MIN(created_at) AS first_seen,
                   MAX(created_at) AS last_seen,
                   MIN(resolved) AS fully_resolved
            FROM logs
            WHERE fingerprint IS NOT NULL
        """
        args = []
        if app:
            query += " AND app_name = ?"
            args.append(app)
        query += " GROUP BY app_name, fingerprint, error_type, level"
        if params.get("unresolved_only") == "true":
            query += " HAVING MIN(resolved) = 0"
        query += " ORDER BY MAX(created_at) DESC LIMIT ?"
        args.append(limit)

        conn = get_db()
        groups = [dict(r) for r in conn.execute(query, args).fetchall()]
        for g in groups:
            latest = conn.execute(
                "SELECT message, stack_trace FROM logs WHERE fingerprint = ? "
                "ORDER BY created_at DESC LIMIT 1",
                (g["fingerprint"],),
            ).fetchone()
            g["latest_message"] = latest["message"] if latest else None
            g["latest_stack_trace"] = latest["stack_trace"] if latest else None
            g["fully_resolved"] = bool(g["fully_resolved"])
        conn.close()
        self._send_json(200, {"groups": groups})

    def _handle_trace(self, params):
        request_id = params.get("request_id")
        session_id = params.get("session_id")
        if not request_id and not session_id:
            self._send_json(400, {"error": "provide request_id or session_id"})
            return
        conn = get_db()
        if request_id:
            rows = conn.execute(
                "SELECT * FROM logs WHERE request_id = ? ORDER BY created_at ASC", (request_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM logs WHERE session_id = ? ORDER BY created_at ASC", (session_id,)
            ).fetchall()
        conn.close()
        self._send_json(200, {"rows": [row_to_dict(r) for r in rows]})

    def _handle_tail(self, params):
        app = params.get("app")
        since = params.get("since") or "1970-01-01T00:00:00"
        query = "SELECT * FROM logs WHERE created_at > ?"
        args = [since]
        if app:
            query += " AND app_name = ?"
            args.append(app)
        if params.get("level"):
            levels = params["level"].split(",")
            query += f" AND level IN ({','.join('?' * len(levels))})"
            args.extend(levels)
        query += " ORDER BY created_at ASC LIMIT 200"

        conn = get_db()
        rows = [row_to_dict(r) for r in conn.execute(query, args).fetchall()]
        conn.close()
        self._send_json(200, {"rows": rows})

    def _handle_resolve(self, params, body):
        fingerprint = params.get("fingerprint")
        if not fingerprint:
            self._send_json(400, {"error": "provide ?fingerprint="})
            return
        conn = get_db()
        cur = conn.execute(
            "UPDATE logs SET resolved = 1, resolved_at = ?, resolved_note = ? WHERE fingerprint = ?",
            (now_iso(), body.get("note", ""), fingerprint),
        )
        conn.commit()
        conn.close()
        self._send_json(200, {"updated_rows": cur.rowcount})

    # -- /commands (extension two-way link) --------------------------------------

    def _handle_insert_command(self, body):
        conn = get_db()
        cur = conn.execute(
            "INSERT INTO commands (created_at, app_name, command, payload) VALUES (?,?,?,?)",
            (now_iso(), body.get("app_name"), body["command"], json.dumps(body.get("payload", {}))),
        )
        conn.commit()
        command_id = cur.lastrowid
        conn.close()
        self._send_json(200, {"id": command_id})

    def _handle_commands_pending(self):
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM commands WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20"
        ).fetchall()
        conn.close()
        self._send_json(200, {"commands": [row_to_dict(r, json_fields=("payload", "result")) for r in rows]})

    def _handle_command_get(self, command_id):
        conn = get_db()
        row = conn.execute("SELECT * FROM commands WHERE id = ?", (command_id,)).fetchone()
        conn.close()
        if not row:
            self._send_json(404, {"error": "not found"})
            return
        self._send_json(200, row_to_dict(row, json_fields=("payload", "result")))

    def _handle_command_update(self, command_id, body):
        conn = get_db()
        conn.execute(
            "UPDATE commands SET status = ?, result = ?, completed_at = ? WHERE id = ?",
            (body.get("status", "done"), json.dumps(body.get("result", {})), now_iso(), command_id),
        )
        conn.commit()
        conn.close()
        self._send_json(200, {"ok": True})


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"centralized-logging server listening on http://{HOST}:{PORT}")
    print(f"database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
