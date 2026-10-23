#!/usr/bin/env bash
# First-time server setup for O! Donut Club. Run from the project folder on the server:
#   bash scripts/setup-server.sh
# It creates .env with fresh random secrets (never overwrites an existing one), makes the
# secrets/ and backups/ folders, sets up Gmail for sign-in codes if you like, checks DNS,
# then starts the stack and runs the go-live check.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
rand() { openssl rand -hex 32; }
b64url() { base64 | tr -d '=\n' | tr '/+' '_-'; }
# set_env NAME VALUE: replaces NAME's line in .env.
set_env() {
  local v=${2//\\/\\\\}
  v=${v//&/\\&}
  v=${v//|/\\|}
  sed -i "s|^$1=.*|$1=$v|" .env
}

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
  DOMAIN=$(printf "%s" "$DOMAIN" | tr -d "[:space:]" | tr "A-Z" "a-z" | sed -E "s#^[a-z]+://##; s#/.*##")
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
  echo "Write this password down. Change it after your first sign-in (Admin → Team)."
fi

if ! grep -qE '^SMTP_HOST=.+' .env; then
  say "Email for members' sign-in codes"
  echo "Members sign in with a 6-digit code sent by email. A Gmail account can send them: you need its"
  echo "address and a 16-letter app password from https://myaccount.google.com/apppasswords"
  read -rp "Gmail address to send from (press Enter to skip for now): " GMAIL
  GMAIL=$(printf '%s' "$GMAIL" | tr -d '[:space:]')
  if [ -n "$GMAIL" ]; then
    read -rp "Its app password (spaces are fine): " GPASS
    set_env SMTP_HOST smtp.gmail.com
    set_env SMTP_PORT 587
    set_env SMTP_USER "$GMAIL"
    set_env SMTP_PASS "$(printf '%s' "$GPASS" | tr -d '[:space:]')"
    set_env SMTP_FROM "O! Donut <$GMAIL>"
    echo "✓ Email set up. After signing in, use Program & automations → Send a test email to check it."
  fi
fi

DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2)
grep -qE '^CADDY_MODE=' .env || printf '\n# direct, or cloudflare once scripts/cloudflare.sh has run\nCADDY_MODE=direct\n' >> .env
say "Checking DNS for $DOMAIN"
SERVER_IP=$(curl -fsS https://api.ipify.org 2>/dev/null || echo "?")
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | head -1 || true)
BEHIND_CLOUDFLARE=false
if [ -n "$DNS_IP" ] && [ "$DNS_IP" = "$SERVER_IP" ]; then
  echo "✓ $DOMAIN points at this server ($SERVER_IP)"
elif [ -n "$DNS_IP" ] && python3 - "$DNS_IP" <<'PY' 2>/dev/null
import ipaddress, re, sys
ip = ipaddress.ip_address(sys.argv[1])
ranges = re.search(r'trusted_proxies static (.*)', open('caddy/cloudflare.Caddyfile').read()).group(1).split()
sys.exit(0 if any(ip in ipaddress.ip_network(r) for r in ranges) else 1)
PY
then
  BEHIND_CLOUDFLARE=true
  echo "✓ $DOMAIN goes through Cloudflare (orange cloud)."
else
  echo "! $DOMAIN resolves to '${DNS_IP:-nothing}', this server is $SERVER_IP. Add an A record before starting, or HTTPS will fail."
fi

say "Still to do:"
grep -qE '^SMTP_HOST=.+' .env || echo "  - Email: run this script again and enter a Gmail address, or fill in SMTP_* in .env. Members can't sign in without it."
grep -qE '^APPLE_TEAM_ID=.+' .env || echo "  - Apple Wallet (optional): sign in, then Admin → Apple Wallet walks you through it."
grep -qE '^GOOGLE_ISSUER_ID=.+' .env || echo "  - Google Wallet (optional): GOOGLE_ISSUER_ID and the service account JSON in ./secrets (docs/04)."
# Wallet certificate files must be readable by the app, which runs as an ordinary user.
find secrets -maxdepth 1 -type f -exec chmod 644 {} + 2>/dev/null || true

read -rp $'\nStart the site now? It takes 5 to 10 minutes the first time. [Y/n] ' go
if [[ ! "$go" =~ ^[Nn] ]]; then
  if $BEHIND_CLOUDFLARE && ! grep -q '^CADDY_MODE=cloudflare' .env; then
    echo
    echo "$DOMAIN is behind Cloudflare, so this server needs a Cloudflare Origin Certificate first."
    bash scripts/cloudflare.sh || true
  fi
  docker compose up -d --build
  echo "Waiting for the app to start..."
  for _ in $(seq 1 30); do docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 2; done
  docker compose exec -T app node dist/cli/doctor.js --online || true
  say "Done. Open https://$DOMAIN/staff/login"
  echo "Owner login is in $(pwd)/.env: run  grep ADMIN_ $(pwd)/.env  to see it again."
fi
