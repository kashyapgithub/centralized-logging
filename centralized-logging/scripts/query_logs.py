#!/usr/bin/env python3
"""
query_logs.py — read-side CLI for the centralized-logging skill.

This is what Claude runs to actually debug an app using the data it's been
collecting, instead of guessing from a pasted error message alone.

Requires: SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment
(service key so RLS is bypassed and full read access is available).

Subcommands
-----------
recent   Show the most recent raw log rows for an app.
groups   Show distinct problems (grouped by fingerprint), most recent first.
trace    Show every log row sharing one request_id or session_id, in order.
tail     Poll for new rows and print them as they arrive.
resolve  Mark a fingerprint as resolved with a note.

Examples
--------
    python3 query_logs.py recent --app my-app --level error --minutes 60
    python3 query_logs.py groups --app my-app --unresolved-only
    python3 query_logs.py trace --request-id req_789
    python3 query_logs.py tail --app my-app
    python3 query_logs.py resolve --fingerprint a1b2c3d4e5f6 --note "fixed in v1.2"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests

REST_TABLE = "app_logs"
REST_VIEW = "app_error_groups"


# ------------------------------------------------------------------------
# Supabase REST helpers
# ------------------------------------------------------------------------

def _client_config() -> tuple[str, dict]:
    """Read connection details from the environment and build headers."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit(
            "Missing SUPABASE_URL and/or SUPABASE_SERVICE_KEY in the "
            "environment. Both are required for query_logs.py."
        )
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    return url.rstrip("/"), headers


def _get(resource: str, params: dict) -> list[dict]:
    """GET against a Supabase REST resource (table or view)."""
    url, headers = _client_config()
    resp = requests.get(f"{url}/rest/v1/{resource}", headers=headers, params=params, timeout=10)
    resp.raise_for_status()
    return resp.json()


def _patch(resource: str, params: dict, body: dict) -> None:
    """PATCH against a Supabase REST resource — used by `resolve`."""
    url, headers = _client_config()
    resp = requests.patch(
        f"{url}/rest/v1/{resource}",
        headers={**headers, "Prefer": "return=minimal"},
        params=params,
        data=json.dumps(body),
        timeout=10,
    )
    resp.raise_for_status()


# ------------------------------------------------------------------------
# Subcommands
# ------------------------------------------------------------------------

def cmd_recent(args: argparse.Namespace) -> None:
    since = (datetime.now(timezone.utc) - timedelta(minutes=args.minutes)).isoformat()
    params: dict[str, Any] = {
        "select": "created_at,level,message,error_type,request_id,context",
        "app_name": f"eq.{args.app}",
        "created_at": f"gte.{since}",
        "order": "created_at.desc",
        "limit": str(args.limit),
    }
    if args.level:
        params["level"] = f"eq.{args.level}"

    rows = _get(REST_TABLE, params)
    if not rows:
        print(f"No {args.level or 'log'} rows for '{args.app}' in the last {args.minutes} min.")
        return
    for row in rows:
        _print_row(row)


def cmd_groups(args: argparse.Namespace) -> None:
    params: dict[str, Any] = {
        "select": "*",
        "app_name": f"eq.{args.app}",
        "order": "last_seen.desc",
        "limit": str(args.limit),
    }
    if args.unresolved_only:
        params["fully_resolved"] = "eq.false"

    rows = _get(REST_VIEW, params)
    if not rows:
        print(f"No error groups for '{args.app}'.")
        return
    for row in rows:
        status = "OPEN" if not row.get("fully_resolved") else "resolved"
        print(f"[{status}] x{row['occurrences']}  {row['error_type'] or row['level']}  "
              f"fp={row['fingerprint']}")
        print(f"    last seen : {row['last_seen']}")
        print(f"    message   : {row['latest_message']}")
        print()


def cmd_trace(args: argparse.Namespace) -> None:
    if not args.request_id and not args.session_id:
        sys.exit("Provide --request-id or --session-id.")
    field = "request_id" if args.request_id else "session_id"
    value = args.request_id or args.session_id
    params = {
        "select": "created_at,app_name,level,message,error_type,stack_trace,context",
        field: f"eq.{value}",
        "order": "created_at.asc",
    }
    rows = _get(REST_TABLE, params)
    if not rows:
        print(f"No rows found for {field}={value}.")
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
            params: dict[str, Any] = {
                "select": "created_at,level,message,error_type,request_id",
                "app_name": f"eq.{args.app}",
                "created_at": f"gt.{last_seen}",
                "order": "created_at.asc",
            }
            if args.level:
                params["level"] = f"eq.{args.level}"
            rows = _get(REST_TABLE, params)
            for row in rows:
                _print_row(row)
                last_seen = row["created_at"]
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopped.")


def cmd_resolve(args: argparse.Namespace) -> None:
    params = {"fingerprint": f"eq.{args.fingerprint}"}
    body = {
        "resolved": True,
        "resolved_at": datetime.now(timezone.utc).isoformat(),
        "resolved_note": args.note,
    }
    _patch(REST_TABLE, params, body)
    print(f"Marked fingerprint {args.fingerprint} as resolved: {args.note}")


def cmd_command(args: argparse.Namespace) -> None:
    """
    Issue a live command to the chrome-debug-logger extension via the
    extension_commands table (see scripts/remote_control_schema.sql — must
    be run once before this works).
    """
    url, headers = _client_config()
    body = {"app_name": args.app, "command": args.action, "payload": {}}
    resp = requests.post(
        f"{url}/rest/v1/extension_commands",
        headers={**headers, "Content-Type": "application/json", "Prefer": "return=representation"},
        data=json.dumps(body),
        timeout=10,
    )
    resp.raise_for_status()
    command_id = resp.json()[0]["id"]
    print(f"Issued '{args.action}' (id={command_id}, app={args.app or 'none'}). "
          f"Waiting for the extension to poll and pick it up...")

    if not args.wait:
        return

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        rows = _get("extension_commands", {"id": f"eq.{command_id}", "select": "status,result"})
        if rows and rows[0]["status"] != "pending":
            print(f"[{rows[0]['status']}] {json.dumps(rows[0]['result'], indent=2)}")
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
    parser = argparse.ArgumentParser(description="Query the centralized app_logs table.")
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
