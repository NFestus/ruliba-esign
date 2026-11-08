#!/bin/bash
# Runs once, when the database volume is first created.
# Two roles:
#   esign_owner  owns the tables, runs migrations. Never used by the running app.
#   esign_app    what the API and worker connect as: read/write rows only.
#                It cannot alter tables, drop triggers, or update/delete audit events.
set -euo pipefail

if [ -z "${DB_APP_PASSWORD:-}" ]; then
  echo "DB_APP_PASSWORD is not set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$DB_APP_PASSWORD" <<'SQL'
CREATE ROLE esign_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO esign_app;
-- Rights on tables the owner creates later (migrations run after this script)
ALTER DEFAULT PRIVILEGES FOR ROLE esign_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO esign_app;
ALTER DEFAULT PRIVILEGES FOR ROLE esign_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO esign_app;
SQL
