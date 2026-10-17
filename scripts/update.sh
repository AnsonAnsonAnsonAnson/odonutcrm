#!/usr/bin/env bash
# Moves the server to the latest version on GitHub. Members, stamps and settings stay in the database.
#   sudo bash /opt/odonut/scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
docker compose up -d --build
# Old app images pile up with every update; clear them so the disk doesn't fill.
docker image prune -f >/dev/null
docker compose ps
