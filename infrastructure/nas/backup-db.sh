#!/usr/bin/env bash
# Runs ON THE NAS (deploy.sh runs the copy from the deployed ref). Takes a copy of
# the installation database before a new image is started for the first time,
# because the API migrates inside its own start and a migration that fails half
# way leaves nothing to go back to.
#
#   backup-db.sh <sha>
#
# Writes $BACKUP_DIR/<sha>.sql.gz (directory mode 700, file mode 600) through
# `docker exec` into the running hotel-postgres-claude: never `docker run`, the
# container is neither stopped nor restarted. The database user, name and password
# come from the environment inside the container; nothing is printed but file
# names and sizes. Exit 1, with no file left behind, when the dump fails, is
# truncated or is empty. The 3 newest dumps stay.
#
# A first deploy (no container yet) has nothing to copy and exits 0 with a note.
#
# Overrides, for the test only: DOCKER, BACKUP_DIR, KEEP.
set -euo pipefail
umask 077

SHA="${1:?usage: backup-db.sh <sha>}"
case "$SHA" in *[!0-9a-f]* | '') echo "   backup: <sha> must be a lowercase hex commit id" >&2; exit 1 ;; esac

DOCKER="${DOCKER:-/usr/local/bin/docker}"
BACKUP_DIR="${BACKUP_DIR:-/volume1/ci/hotel/backup}"
KEEP="${KEEP:-3}"
CONTAINER="${CONTAINER:-hotel-postgres-claude}"

# A rerun of the same sha (deploy.sh again after editing hotel.env) must not replace the
# pre-migration copy with a dump of the already migrated database.
if [ -s "$BACKUP_DIR/$SHA.sql.gz" ]; then
  echo "   backup: $BACKUP_DIR/$SHA.sql.gz already exists, kept (no new dump)"
  exit 0
fi

# Found by the compose labels, as deploy.sh finds its containers; the name is only the fallback for the message.
FOUND="$("$DOCKER" ps -a --filter label=com.docker.compose.project=claude-hotel \
  --filter label=com.docker.compose.service=postgres --format '{{.Names}}')"
if [ -n "$FOUND" ]; then CONTAINER="$FOUND"; fi
if [ -z "$FOUND" ]; then
  echo "   backup: no $CONTAINER yet (first deploy), nothing to copy"
  exit 0
fi
if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]; then
  echo "   backup: $CONTAINER exists but is not running; start it and deploy again" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
OUT="$BACKUP_DIR/$SHA.sql.gz"
TMP="$BACKUP_DIR/.$SHA.sql.gz.partial"
trap 'rm -f "$TMP"' EXIT
rm -f "$TMP"

# --clean --if-exists: the dump restores over an existing database.
# The single quotes keep the variables for the shell INSIDE the container.
"$DOCKER" exec "$CONTAINER" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip -c > "$TMP" || { echo "   backup: pg_dump failed; deploy stopped" >&2; exit 1; }

# gzip of nothing is still a 20-byte file, so look inside: a complete dump starts
# with the pg_dump banner and ends with its closing line.
if ! gzip -dc "$TMP" | awk '/^-- PostgreSQL database dump$/ { head = 1 } /^-- PostgreSQL database dump complete$/ { tail = 1 } END { exit !(head && tail) }'; then
  echo "   backup: the dump is empty or incomplete; deploy stopped" >&2
  exit 1
fi

chmod 600 "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT
echo "   backup: $OUT ($(wc -c < "$OUT") bytes)"

# Keep the newest $KEEP dumps (by modification time); only *.sql.gz in this directory.
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" && echo "   backup: removed $old"
done
true
