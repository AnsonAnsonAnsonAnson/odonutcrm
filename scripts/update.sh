#!/usr/bin/env bash
# Moves the server to the latest version on GitHub. Members, stamps and settings stay in the database.
#   sudo bash /opt/odonut/scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Downloading the latest version"
git pull --ff-only
# Picks up any new server protections; changes nothing that is already set.
[ "$(id -u)" = 0 ] && bash scripts/harden-server.sh >/dev/null

# A fresh copy of the database first, so an update can always be undone.
if docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  say "Backing up the database"
  mkdir -p backups
  f="backups/odonut-before-update-$(date +%Y%m%d-%H%M).sql.gz"
  if docker compose exec -T db pg_dump -U odonut -d odonut --no-owner --clean --if-exists | gzip > "$f.tmp"; then
    mv "$f.tmp" "$f"
    chmod 600 "$f"
    echo "  Saved $f"
  else
    rm -f "$f.tmp"
    echo "  The backup failed, so the update was stopped. Nothing has changed on the site."
    exit 1
  fi
fi

say "Rebuilding and restarting (a few minutes)"
docker compose up -d --build
# Old app images pile up with every update; clear them so the disk doesn't fill.
docker image prune -f >/dev/null

echo "Waiting for the app to start..."
healthy=false
for _ in $(seq 1 45); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if $healthy; then
  docker compose exec -T app node dist/cli/doctor.js || true
  say "Update finished. The site is running."
else
  docker compose ps
  docker compose logs --tail 40 app || true
  say "The app has not come back yet. The messages above say why; the backup is in $(pwd)/backups."
  exit 1
fi
