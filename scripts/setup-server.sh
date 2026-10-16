#!/usr/bin/env bash
# First-time server setup for O! Donut Club. Run from the project folder on the server:
#   bash scripts/setup-server.sh
# It creates .env with fresh random secrets (never overwrites an existing one), makes the
# secrets/ and backups/ folders, checks DNS, then offers to start the stack and run the go-live check.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
rand() { openssl rand -hex 32; }
b64url() { base64 | tr -d '=\n' | tr '/+' '_-'; }

command -v docker >/dev/null || { echo "Docker is not installed. On Ubuntu: curl -fsSL https://get.docker.com | sh"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is missing (docker compose ...)."; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed (apt install openssl)."; exit 1; }

mkdir -p secrets backups
chmod 700 backups

if [ -f .env ]; then
  say ".env already exists; leaving it as it is."
else
  say "Creating .env"
  read -rp "Domain for the member site (e.g. club.odonut.hk): " DOMAIN
  read -rp "Owner login email: " ADMIN_EMAIL
  ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')

  # Web push (VAPID) keys: a P-256 key pair in the raw base64url form browsers expect.
  tmp=$(mktemp -d)
  openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/vapid.pem" 2>/dev/null
  VAPID_PRIVATE=$(openssl ec -in "$tmp/vapid.pem" -outform DER 2>/dev/null | tail -c +8 | head -c 32 | b64url)
  VAPID_PUBLIC=$(openssl ec -in "$tmp/vapid.pem" -pubout -outform DER 2>/dev/null | tail -c 65 | b64url)
  rm -rf "$tmp"

  sed -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
      -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" \
      -e "s|^APP_SECRET=.*|APP_SECRET=$(rand)|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|" \
      -e "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=$ADMIN_EMAIL|" \
      -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASSWORD|" \
      -e "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=$VAPID_PUBLIC|" \
      -e "s|^VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=$VAPID_PRIVATE|" \
      .env.example > .env
  chmod 600 .env
  say "Owner login: $ADMIN_EMAIL / $ADMIN_PASSWORD"
  echo "Write this password down now; it is not shown again. Change it after your first sign-in (Admin → Team)."
fi

DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2)
say "Checking DNS for $DOMAIN"
SERVER_IP=$(curl -fsS https://api.ipify.org 2>/dev/null || echo "?")
DNS_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -n "$DNS_IP" ] && [ "$DNS_IP" = "$SERVER_IP" ]; then
  echo "✓ $DOMAIN points at this server ($SERVER_IP)"
else
  echo "! $DOMAIN resolves to '${DNS_IP:-nothing}', this server is $SERVER_IP. Add an A record before starting, or HTTPS will fail."
fi

say "Still to do by hand (see docs/04):"
grep -qE '^SMTP_HOST=.+' .env || echo "  - SMTP_* settings, so members get sign-in codes"
grep -qE '^APPLE_TEAM_ID=.+' .env || echo "  - Apple: APPLE_PASS_TYPE_ID, APPLE_TEAM_ID and pass-cert.pem, pass-key.pem, wwdr.pem in ./secrets"
grep -qE '^GOOGLE_ISSUER_ID=.+' .env || echo "  - Google Wallet (optional): GOOGLE_ISSUER_ID and the service account JSON in ./secrets"
ls secrets/*.pem >/dev/null 2>&1 && chmod 644 secrets/* || true

read -rp $'\nStart the stack now? [y/N] ' go
if [[ "$go" =~ ^[Yy]$ ]]; then
  docker compose up -d --build
  echo "Waiting for the app to start..."
  for _ in $(seq 1 30); do docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 2; done
  docker compose exec -T app node dist/cli/doctor.js --online || true
fi
