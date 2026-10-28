#!/usr/bin/env bash
# Puts the site behind Cloudflare, or takes it back out. Run on the server:
#   sudo bash /opt/odonut/scripts/cloudflare.sh              switch on (asks for the Origin Certificate)
#   sudo bash /opt/odonut/scripts/cloudflare.sh --off        back to visitors reaching this server directly
#   sudo bash /opt/odonut/scripts/cloudflare.sh --check-ips  compare our list of Cloudflare addresses with Cloudflare's
#
# Before switching on, in the Cloudflare dashboard: the domain's DNS record has the orange cloud
# (Proxied) and SSL/TLS is set to "Full (strict)". The certificate comes from
# SSL/TLS -> Origin Server -> Create Certificate. Step by step: docs/08-security.md.
#
# Once on, the server only answers Cloudflare: anyone who finds the server's own IP address and
# tries to go around Cloudflare's protection gets no answer at all.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
# set_env NAME VALUE: replaces NAME's line in .env, or adds it.
set_env() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
cf_ranges() { grep -m1 'trusted_proxies static' caddy/cloudflare.Caddyfile | sed 's/.*static //' | tr ' ' '\n' | sed '/^$/d'; }

[ -f .env ] || { echo "No .env here. Install the site first (scripts/install.sh)."; exit 1; }
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2)

if [ "${1:-}" = "--check-ips" ]; then
  live=$( (curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6) | sed '/^$/d' | sort)
  ours=$(cf_ranges | sort)
  if [ "$live" = "$ours" ]; then ok "Our Cloudflare address list matches Cloudflare's ($(echo "$ours" | wc -l) ranges)."; exit 0; fi
  bad "Cloudflare's address list has changed. Update the app (sudo bash scripts/update.sh), or ask for caddy/cloudflare.Caddyfile to be updated."
  diff <(echo "$ours") <(echo "$live") || true
  exit 1
fi

if [ "${1:-}" = "--off" ]; then
  say "Switching back to direct mode (no Cloudflare)"
  set_env CADDY_MODE direct
  docker compose up -d caddy
  echo "Done. In Cloudflare, set the DNS record to grey cloud (DNS only) so visitors reach the server directly."
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "Please run it with sudo: sudo bash scripts/cloudflare.sh"; exit 1; }
[ -t 0 ] || exec </dev/tty
command -v openssl >/dev/null || { echo "openssl is needed (apt install openssl)."; exit 1; }

say "Is $DOMAIN going through Cloudflare yet?"
in_cloudflare() {
  # True when the IPv4 address $1 is inside one of Cloudflare's ranges.
  python3 - "$1" <<'PY' 2>/dev/null
import ipaddress, re, sys
ip = ipaddress.ip_address(sys.argv[1])
ranges = re.search(r'trusted_proxies static (.*)', open('caddy/cloudflare.Caddyfile').read()).group(1).split()
sys.exit(0 if any(ip in ipaddress.ip_network(r) for r in ranges) else 1)
PY
}
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -n "$DNS_IP" ] && in_cloudflare "$DNS_IP"; then
  ok "$DOMAIN points at Cloudflare ($DNS_IP)"
else
  bad "$DOMAIN points at '${DNS_IP:-nothing}', which is not Cloudflare."
  echo "  In Cloudflare → DNS, click the grey cloud next to $DOMAIN so it turns orange (Proxied), wait a minute, then run this again."
  echo "  Switching now would make the site unreachable until that's done."
  read -rp "  Switch anyway? [y/N] " go
  [[ "$go" =~ ^[Yy] ]] || exit 1
fi

# read_pem LABEL: reads a pasted PEM block (up to its -----END line) from the keyboard.
read_pem() {
  local line out=""
  while IFS= read -r line; do
    line=${line%$'\r'}
    [ -z "$out" ] && [ -z "${line// }" ] && continue
    out+="$line"$'\n'
    [[ "$line" == -----END* ]] && break
  done
  printf '%s' "$out"
}

mkdir -p secrets/cloudflare
chmod 700 secrets/cloudflare
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "Paste the Origin Certificate"
echo "In Cloudflare: SSL/TLS → Origin Server → Create Certificate → keep the defaults → Create."
echo "Copy the whole 'Origin Certificate' box (from -----BEGIN to -----END) and paste it here:"
read_pem > "$tmp/origin.pem"
if ! openssl x509 -in "$tmp/origin.pem" -noout 2>/dev/null; then bad "That isn't a certificate. Run this again and copy the whole box."; exit 1; fi
ok "Certificate read ($(openssl x509 -in "$tmp/origin.pem" -noout -enddate | sed 's/notAfter=/valid until /'))"
if ! openssl x509 -in "$tmp/origin.pem" -noout -checkhost "$DOMAIN" | grep -q 'does match'; then
  bad "This certificate doesn't cover $DOMAIN. Create one that lists $DOMAIN (the defaults *.yourdomain and yourdomain do)."
  exit 1
fi
openssl x509 -in "$tmp/origin.pem" -noout -issuer | grep -qi cloudflare || echo "  (Note: this certificate wasn't issued by Cloudflare. It will still be used.)"

say "Paste the Private Key"
echo "Now copy the 'Private Key' box from the same Cloudflare page and paste it here:"
read_pem > "$tmp/origin-key.pem"
if ! openssl pkey -in "$tmp/origin-key.pem" -noout 2>/dev/null; then bad "That isn't a private key. Run this again and copy the whole Private Key box."; exit 1; fi
if [ "$(openssl x509 -in "$tmp/origin.pem" -noout -pubkey | openssl sha256)" != "$(openssl pkey -in "$tmp/origin-key.pem" -pubout | openssl sha256)" ]; then
  bad "The key doesn't belong to that certificate. Copy both boxes from the same Cloudflare page."
  exit 1
fi
ok "Private key matches the certificate"

install -m 600 "$tmp/origin.pem" secrets/cloudflare/origin.pem
install -m 600 "$tmp/origin-key.pem" secrets/cloudflare/origin-key.pem
ok "Saved in $(pwd)/secrets/cloudflare (only the server's admin can read them)"

say "Switching the web server to Cloudflare mode"
previous=$(grep -E '^CADDY_MODE=' .env | cut -d= -f2 || true)
set_env CADDY_MODE cloudflare
docker compose up -d caddy

say "Checking (up to a minute while everything starts)"
code=""
for _ in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/healthz" || true)
  [ "$code" = 200 ] && break
  sleep 5
done
ray=$(curl -sI --max-time 15 "https://$DOMAIN/healthz" | grep -i '^cf-ray' || true)
if [ "$code" = 200 ] && [ -n "$ray" ]; then
  ok "https://$DOMAIN works through Cloudflare"
else
  bad "https://$DOMAIN answered '${code:-nothing}' (expected 200 through Cloudflare)."
  echo "  Most likely: Cloudflare SSL/TLS isn't 'Full (strict)' yet, or the orange cloud is off."
  read -rp "  Go back to how it was? [Y/n] " back
  if [[ ! "$back" =~ ^[Nn] ]]; then
    set_env CADDY_MODE "${previous:-direct}"
    docker compose up -d caddy
    echo "  Back to ${previous:-direct} mode. Fix the Cloudflare setting and run this again."
    exit 1
  fi
fi
direct=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" || true)
if [ "$direct" = 000 ]; then
  ok "Going around Cloudflare to the server's own address gets no answer"
else
  bad "The server still answers directly (got $direct). Check that caddy/cloudflare.Caddyfile is in use: docker compose logs caddy"
fi
echo
echo "Done. Next: finish the Cloudflare settings in docs/08-security.md (the steps after the certificate)."
