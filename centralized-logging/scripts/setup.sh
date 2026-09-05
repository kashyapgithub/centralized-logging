#!/usr/bin/env bash
# setup.sh — applies the centralized-logging schema to a Supabase Postgres
# database via psql. Meant to be RUN by an agent (Claude Code, or you)
# given a connection string — not hand-pasted into the Supabase web UI.
#
# Usage:
#   SUPABASE_DB_URL="postgresql://postgres:[password]@db.xxxx.supabase.co:5432/postgres" \
#     bash scripts/setup.sh [--with-remote-control]
#
# Find SUPABASE_DB_URL in the Supabase dashboard:
#   Project Settings > Database > Connection string > URI
#
# --with-remote-control also applies remote_control_schema.sql (the
# two-way link with the chrome-debug-logger extension). Read the trade-off
# comment at the top of that file before passing this flag.

set -euo pipefail

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "Set SUPABASE_DB_URL to your Supabase Postgres connection string first." >&2
  echo "Find it in: Project Settings > Database > Connection string > URI" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install the postgresql-client package and re-run." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Applying base schema (app_logs table, indexes, RLS, error-grouping view)"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/setup_schema.sql"

if [[ "${1:-}" == "--with-remote-control" ]]; then
  echo "==> Applying remote-control schema (extension_commands + widened anon SELECT)"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/remote_control_schema.sql"
fi

echo "==> Done. Sanity check:"
psql "$SUPABASE_DB_URL" -c "select count(*) as row_count from app_logs;"
