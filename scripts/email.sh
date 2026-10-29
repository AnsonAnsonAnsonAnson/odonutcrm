#!/usr/bin/env bash
# Changes which email service sends members' sign-in codes and welcome emails.
#   sudo bash /opt/odonut/scripts/email.sh
# Asks a few questions, saves the answers in .env, restarts the app and runs the go-live check.
# Step-by-step guide: docs/09-email-delivery.md
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# set_env NAME VALUE: replaces NAME's line in .env, or adds it when missing.
set_env() {
  local v=${2//\\/\\\\}
  v=${v//&/\\&}
  v=${v//|/\\|}
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$v|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
trim() { printf '%s' "$1" | tr -d '[:space:]'; }

[ -f .env ] || { echo "No .env here yet: run scripts/setup-server.sh first."; exit 1; }

say "Which service should send the club's emails?"
echo "  1) Resend (recommended: free for up to 100 emails a day)"
echo "  2) Amazon SES"
echo "  3) Gmail or Google Workspace"
echo "  4) Something else"
read -rp "Type 1, 2, 3 or 4: " CHOICE

case "$CHOICE" in
  1)
    HOST=smtp.resend.com PORT=587 USER=resend
    read -rp "Resend API key (starts with re_): " PASS
    ;;
  2)
    read -rp "SES region (press Enter for Sydney, ap-southeast-2): " REGION
    REGION=$(trim "${REGION:-ap-southeast-2}")
    HOST="email-smtp.$REGION.amazonaws.com" PORT=587
    read -rp "SES SMTP username: " USER
    read -rp "SES SMTP password: " PASS
    ;;
  3)
    HOST=smtp.gmail.com PORT=587
    read -rp "Gmail or Workspace address that signs in: " USER
    read -rp "Its 16-letter app password (spaces are fine): " PASS
    ;;
  4)
    read -rp "SMTP server name: " HOST
    read -rp "Port (press Enter for 587): " PORT
    PORT=${PORT:-587}
    read -rp "Username: " USER
    read -rp "Password: " PASS
    ;;
  *) echo "Nothing changed."; exit 1 ;;
esac

read -rp "Send from which address (e.g. club@odonuthk.com): " FROM
FROM=$(trim "$FROM")
[ -n "$FROM" ] || FROM=$(trim "$USER")
read -rp "Name members see as the sender (press Enter for O! Donut Club): " NAME
NAME=${NAME:-O! Donut Club}
read -rp "Inbox for members' replies (press Enter to skip): " REPLY

set_env SMTP_HOST "$(trim "$HOST")"
set_env SMTP_PORT "$(trim "$PORT")"
set_env SMTP_USER "$(trim "$USER")"
set_env SMTP_PASS "$(trim "$PASS")"
set_env SMTP_FROM "$NAME <$FROM>"
set_env SMTP_REPLY_TO "$(trim "$REPLY")"
chmod 600 .env

say "Restarting the app with the new email settings"
docker compose up -d app
for _ in $(seq 1 30); do
  docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 2
done
docker compose exec -T app node dist/cli/doctor.js || true
say "Done. In the admin, open Program & automations → Send a test email to see one arrive."
