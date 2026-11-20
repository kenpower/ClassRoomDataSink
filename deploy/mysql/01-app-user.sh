#!/bin/sh
# Runs once, on first database initialisation (docker-entrypoint-initdb.d).
# MYSQL_USER (the migration user) gets ALL on the database from the image; this adds the API's
# runtime user with DML only, so the running API cannot change the schema.
set -eu
APP_USER="${DB_APP_USER:-roomsink}"
if [ -n "${DB_APP_PASSWORD_FILE:-}" ]; then APP_PASS="$(cat "$DB_APP_PASSWORD_FILE")"; else APP_PASS="${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"; fi
ROOT_PASS="${MYSQL_ROOT_PASSWORD:-$(cat "${MYSQL_ROOT_PASSWORD_FILE:-/dev/null}" 2>/dev/null || true)}"
esc() { printf "%s" "$1" | sed "s/'/''/g"; }
mysql -uroot -p"$ROOT_PASS" <<SQL
CREATE USER IF NOT EXISTS '$(esc "$APP_USER")'@'%' IDENTIFIED BY '$(esc "$APP_PASS")';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${MYSQL_DATABASE}\`.* TO '$(esc "$APP_USER")'@'%';
FLUSH PRIVILEGES;
SQL
