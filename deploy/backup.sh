#!/usr/bin/env bash
# Backup consistente do banco (pode rodar com o app ligado). Mantém os 14 mais recentes.
set -euo pipefail
DEST=/var/backups/pegasus
mkdir -p "$DEST"
sqlite3 /var/lib/pegasus/pegasus.sqlite ".backup '$DEST/pegasus-$(date +%F-%H%M).sqlite'"
ls -1t "$DEST"/pegasus-*.sqlite | tail -n +15 | xargs -r rm --
