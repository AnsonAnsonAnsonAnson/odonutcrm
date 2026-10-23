#!/usr/bin/env bash
# One-command install of O! Donut Club on a fresh Ubuntu server (22.04 or newer). Paste this on the server:
#   curl -fsSL https://raw.githubusercontent.com/AnsonAnsonAnsonAnson/odonutcrm/main/scripts/install.sh -o install.sh && sudo bash install.sh
# It installs git and Docker, adds swap on small servers, downloads the app to /opt/odonut, locks
# the server down (scripts/harden-server.sh) and runs scripts/setup-server.sh, which asks a few questions and starts the site. Safe to run again.
set -euo pipefail

REPO=${ODONUT_REPO:-https://github.com/AnsonAnsonAnsonAnson/odonutcrm.git}
DIR=${ODONUT_DIR:-/opt/odonut}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Please run it with sudo: sudo bash install.sh"; exit 1; }
# The questions need a keyboard even when this script arrives through a pipe.
[ -t 0 ] || exec </dev/tty

say "Installing git and Docker (a few minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl openssl ca-certificates >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# Building the app needs more than 1 GB of memory; swap lets the cheapest servers manage it.
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 1900 ] && ! swapon --show | grep -q .; then
  say "Adding 2 GB of swap (this server has ${mem_mb} MB of memory)"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ -d "$DIR/.git" ]; then
  say "Updating the app in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading the app to $DIR"
  git clone -q "$REPO" "$DIR"
fi

cd "$DIR"
# Automatic security updates, firewall, SSH and kernel hardening.
bash scripts/harden-server.sh
exec bash scripts/setup-server.sh
