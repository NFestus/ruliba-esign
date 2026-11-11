#!/bin/bash
# Nightly encrypted backup, run on the production server by cron (02:45 Kigali time):
#   45 2 * * * /opt/ruliba-esign/infra/backup/backup.sh >> /var/log/esign-backup.log 2>&1
# Under Dokploy, set COMPOSE_PROJECT to the app name Dokploy shows (its containers are named
# <app-name>-postgres-1), e.g. in the crontab line:
#   45 2 * * * COMPOSE_PROJECT=ruliba-esign-ab12cd /opt/esign-backup/backup.sh >> /var/log/esign-backup.log 2>&1
# The script only needs docker and the project name, so it can live anywhere on the server.
#
# 1. Dumps the database (custom format, restorable with pg_restore).
# 2. Archives the encrypted document files volume.
# 3. Encrypts both with `age` to Ruliba's backup public key: the server can write backups
#    but cannot read them. The private key stays offline at Ruliba.
# 4. Copies them to the Ruliba server room over SSH (rsync), keeping 30 daily + 12 monthly copies.
#
# Phase 3 adds continuous WAL archiving (pgBackRest) for restore to any minute.
set -euo pipefail

cd "$(dirname "$0")"
: "${COMPOSE_PROJECT:=ruliba-esign}"   # Docker Compose project name (compose.yml sets ruliba-esign)
: "${BACKUP_DIR:=/var/backups/esign}"
: "${AGE_RECIPIENT_FILE:=/etc/esign/backup-recipient.txt}"   # age public key, one line
: "${REMOTE:=esign-backup@serverroom.ruliba.local:/backups/esign}"  # set to the real server-room target
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$BACKUP_DIR"

PG=$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter "label=com.docker.compose.service=postgres" | head -n1)
if [ -z "$PG" ]; then
  echo "[$STAMP] no running postgres container for project '$COMPOSE_PROJECT'; set COMPOSE_PROJECT" >&2
  exit 1
fi
FILES_VOLUME="${COMPOSE_PROJECT}_files_data"

echo "[$STAMP] database dump"
docker exec "$PG" pg_dump -U esign_owner -d esign -Fc \
  | age -R "$AGE_RECIPIENT_FILE" > "$BACKUP_DIR/db_$STAMP.dump.age"

if docker volume inspect "$FILES_VOLUME" >/dev/null 2>&1; then
  echo "[$STAMP] document files (already encrypted file by file; age adds a second layer for the copy)"
  docker run --rm -v "$FILES_VOLUME":/data:ro alpine tar -C /data -cf - . \
    | age -R "$AGE_RECIPIENT_FILE" > "$BACKUP_DIR/files_$STAMP.tar.age"
fi

sha256sum "$BACKUP_DIR"/*_"$STAMP".* > "$BACKUP_DIR/SHA256SUMS_$STAMP"

echo "[$STAMP] copy to server room"
rsync -a --partial "$BACKUP_DIR"/*_"$STAMP"* "$REMOTE/"

# Local retention: 7 days (the server-room copy keeps the long history)
find "$BACKUP_DIR" -type f -mtime +7 -delete
echo "[$STAMP] done"
