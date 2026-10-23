#!/usr/bin/env bash
# Backup lógico do PostgreSQL com pg_dump. Mantém os 14 mais recentes.
# Requer: postgresql-client instalado e DATABASE_URL no ambiente (ex.: source /etc/pegasus.env).
set -euo pipefail
: "${DATABASE_URL:?Defina DATABASE_URL}"
DEST=/var/backups/pegasus
mkdir -p "$DEST"
pg_dump "$DATABASE_URL" --no-owner --format=custom --file "$DEST/pegasus-$(date +%F-%H%M).dump"
ls -1t "$DEST"/pegasus-*.dump | tail -n +15 | xargs -r rm --
