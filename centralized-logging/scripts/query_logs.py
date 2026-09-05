#!/usr/bin/env python3
"""
query_logs.py — read-side CLI for the centralized-logging skill.

This is what Claude runs to actually debug an app using data the local
log server has collected, instead of guessing from a pasted error alone.

Talks to server.py over plain HTTP — no account, no API key. Point it at a
different machine with LOG_SERVER_URL if the server isn't running locally.

Subcommands
-----------
recent   Show the most recent raw log rows for an app.
groups   Show distinct problems (grouped by fingerprint), most recent first.
trace    Show every log row sharing one request_id or session_id, in order.
tail     Poll for new rows and print them as they arrive.
resolve  Mark a fingerprint as resolved with a note.
command  Send a live command to the chrome-debug-logger extension.

Examples
--------
    python3 query_logs.py recent --app my-app --level error --minutes 60
    python3 query_logs.py groups --app my-app --unresolved-only
    python3 query_logs.py trace --request-id req_789
    python3 query_logs.py tail --app my-app
    python3 query_logs.py resolve --fingerprint a1b2c3d4e5f6 --note "fixed in v1.2"
    python3 query_logs.py command --action localstorage_snapshot --app myapp.com
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests

SERVER_URL = os.environ.get("LOG_SERVER_URL", "http://127.0.0.1:4317").rstrip("/")


# ------------------------------------------------------------------------
# HTTP helpers
# ------------------------------------------------------------------------

def _get(path: str, params: dict) -> dict:
    try:
        resp = requests.get(f"{SERVER_URL}{path}", params=params, timeout=10)
    except requests.ConnectionError:
        sys.exit(f"Couldn't reach the log server at {SERVER_URL}. Is `python3 server.py` running?")
    resp.raise_for_status()
    return resp.json()


def _post(path: str, body: dict) -> dict:
    try:
        resp = requests.post(f"{SERVER_URL}{path}", json=body, timeout=10)
    except requests.ConnectionError:
        sys.exit(f"Couldn't reach the log server at {SERVER_URL}. Is `python3 server.py` running?")
    resp.raise_for_status()
    return resp.json()


def _patch(path: str, params: dict, body: dict) -> dict:
    try:
        resp = requests.patch(f"{SERVER_URL}{path}", params=params, json=body, timeout=10)
    except requests.ConnectionError:
        sys.exit(f"Couldn't reach the log server at {SERVER_URL}. Is `python3 server.py` running?")
    resp.raise_for_status()
    return resp.json()


# ------------------------------------------------------------------------
# Subcommands
# ------------------------------------------------------------------------

def cmd_recent(args: argparse.Namespace) -> None:
    params: dict[str, Any] = {"app": args.app, "minutes": args.minutes, "limit": args.limit}
    if args.level:
        params["level"] = args.level
    rows = _get("/logs/recent", params).get("rows", [])
    if not rows:
        print(f"No {args.level or 'log'} rows for '{args.app}' in the last {args.minutes} min.")
        return
    for row in rows:
        _print_row(row)


def cmd_groups(args: argparse.Namespace) -> None:
    params: dict[str, Any] = {"app": args.app, "limit": args.limit}
    if args.unresolved_only:
        params["unresolved_only"] = "true"
    groups = _get("/logs/groups", params).get("groups", [])
    if not groups:
        print(f"No error groups for '{args.app}'.")
        return
    for g in groups:
        status = "resolved" if g["fully_resolved"] else "OPEN"
        print(f"[{status}] x{g['occurrences']}  {g['error_type'] or g['level']}  fp={g['fingerprint']}")
        print(f"    last seen : {g['last_seen']}")
        print(f"    message   : {g['latest_message']}")
        print()


def cmd_trace(args: argparse.Namespace) -> None:
    if not args.request_id and not args.session_id:
        sys.exit("Provide --request-id or --session-id.")
    params = {"request_id": args.request_id} if args.request_id else {"session_id": args.session_id}
    rows = _get("/logs/trace", params).get("rows", [])
    if not rows:
        print("No rows found.")
        return
    for row in rows:
        _print_row(row, show_app=True)
        if row.get("stack_trace"):
            print(f"    stack:\n{_indent(row['stack_trace'])}")


def cmd_tail(args: argparse.Namespace) -> None:
    print(f"Tailing '{args.app}' (level={args.level or 'any'}) — Ctrl+C to stop.")
    last_seen = datetime.now(timezone.utc).isoformat()
    try:
        while True:
            params: dict[str, Any] = {"app": args.app, "since": last_seen}
            if args.level:
                params["level"] = args.level
            rows = _get("/logs/tail", params).get("rows", [])
            for row in rows:
                _print_row(row)
                last_seen = row["created_at"]
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopped.")


def cmd_resolve(args: argparse.Namespace) -> None:
    result = _patch("/logs/resolve", {"fingerprint": args.fingerprint}, {"note": args.note})
    print(f"Marked fingerprint {args.fingerprint} as resolved ({result['updated_rows']} rows): {args.note}")


def cmd_command(args: argparse.Namespace) -> None:
    """Issue a live command to the chrome-debug-logger extension."""
    result = _post("/commands", {"app_name": args.app, "command": args.action, "payload": {}})
    command_id = result["id"]
    print(f"Issued '{args.action}' (id={command_id}, app={args.app or 'none'}). "
          f"Waiting for the extension to poll and pick it up...")

    if not args.wait:
        return

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        row = _get(f"/commands/{command_id}", {})
        if row["status"] != "pending":
            print(f"[{row['status']}] {json.dumps(row['result'], indent=2)}")
            return
        time.sleep(1)
    print("Timed out waiting for a response — is the extension open in Chrome and polling?")


# ------------------------------------------------------------------------
# Formatting helpers
# ------------------------------------------------------------------------

def _print_row(row: dict, show_app: bool = False) -> None:
    prefix = f"[{row.get('app_name')}] " if show_app else ""
    print(f"{row['created_at']}  {prefix}{row['level'].upper():<5}  {row['message']}")
    if row.get("error_type"):
        print(f"    error_type: {row['error_type']}")
    if row.get("request_id"):
        print(f"    request_id: {row['request_id']}")
    if row.get("context") and row["context"] not in ({}, None):
        print(f"    context: {json.dumps(row['context'])}")


def _indent(text: str, spaces: int = 6) -> str:
    pad = " " * spaces
    return "\n".join(pad + line for line in text.splitlines())


# ------------------------------------------------------------------------
# Argument parsing
# ------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Query the local centralized-logging server.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_recent = sub.add_parser("recent", help="Most recent raw log rows.")
    p_recent.add_argument("--app", required=True)
    p_recent.add_argument("--level", choices=["debug", "info", "warn", "error", "fatal"])
    p_recent.add_argument("--minutes", type=int, default=60)
    p_recent.add_argument("--limit", type=int, default=50)
    p_recent.set_defaults(func=cmd_recent)

    p_groups = sub.add_parser("groups", help="Distinct problems, grouped by fingerprint.")
    p_groups.add_argument("--app", required=True)
    p_groups.add_argument("--unresolved-only", action="store_true")
    p_groups.add_argument("--limit", type=int, default=20)
    p_groups.set_defaults(func=cmd_groups)

    p_trace = sub.add_parser("trace", help="Every row for one request_id or session_id, in order.")
    p_trace.add_argument("--request-id")
    p_trace.add_argument("--session-id")
    p_trace.set_defaults(func=cmd_trace)

    p_tail = sub.add_parser("tail", help="Poll for new rows and print them as they arrive.")
    p_tail.add_argument("--app", required=True)
    p_tail.add_argument("--level", choices=["debug", "info", "warn", "error", "fatal"])
    p_tail.add_argument("--interval", type=float, default=3.0, help="Poll interval in seconds.")
    p_tail.set_defaults(func=cmd_tail)

    p_resolve = sub.add_parser("resolve", help="Mark a fingerprint as resolved.")
    p_resolve.add_argument("--fingerprint", required=True)
    p_resolve.add_argument("--note", required=True)
    p_resolve.set_defaults(func=cmd_resolve)

    p_command = sub.add_parser(
        "command", help="Send a live command to the chrome-debug-logger extension."
    )
    p_command.add_argument("--action", required=True,
                            choices=["flush", "localstorage_snapshot", "attach", "detach", "status"])
    p_command.add_argument("--app", help="Target hostname (required for attach/detach/localstorage_snapshot).")
    p_command.add_argument("--no-wait", dest="wait", action="store_false",
                            help="Fire and forget instead of polling for the result.")
    p_command.add_argument("--timeout", type=int, default=20, help="Seconds to wait for a result.")
    p_command.set_defaults(func=cmd_command, wait=True)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
