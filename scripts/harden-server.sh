#!/usr/bin/env bash
# Locks down the server itself (Ubuntu 22.04 or newer). install.sh runs it; safe to run again:
#   sudo bash /opt/odonut/scripts/harden-server.sh
# - Security updates install themselves every night; if one needs a restart, the server restarts
#   at 04:00 Hong Kong time and the site comes back on its own.
# - Firewall: only SSH and the web ports are open.
# - SSH: no password logins and no direct root login (only keys, which is what the Lightsail
#   browser terminal uses). Skipped if this server has no SSH key set up, so nobody is locked out.
# - Fail2ban blocks addresses that keep guessing SSH logins.
# - Kernel network settings that resist spoofing and SYN floods.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Please run it with sudo: sudo bash scripts/harden-server.sh"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "Server security"
apt-get install -y -qq unattended-upgrades fail2ban ufw >/dev/null

# ---- Automatic security updates ----
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Server clocks run on UTC: 20:00 UTC is 04:00 in Hong Kong, when the shop is closed.
cat > /etc/apt/apt.conf.d/52odonut-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "20:00";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "Security updates install automatically (restart at 04:00 HK time when needed)"

# ---- Firewall ----
ssh_port=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
ssh_port=${ssh_port:-22}
ufw allow "$ssh_port"/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
ok "Firewall on: only SSH ($ssh_port) and web (80, 443) are open"

# ---- SSH ----
has_key=false
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -s "$f" ] && has_key=true
done
if $has_key && [ -d /etc/ssh/sshd_config.d ]; then
  cat > /etc/ssh/sshd_config.d/10-odonut.conf <<'EOF'
# Written by O! Donut scripts/harden-server.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxAuthTries 4
LoginGraceTime 30
X11Forwarding no
EOF
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    ok "SSH accepts keys only (no passwords, no root login)"
  else
    rm -f /etc/ssh/sshd_config.d/10-odonut.conf
    echo "  ! SSH settings left unchanged (the check failed)."
  fi
else
  echo "  ! SSH settings left unchanged: no SSH key is set up on this server, so passwords stay allowed."
fi

cat > /etc/fail2ban/jail.d/odonut.local <<EOF
[sshd]
enabled = true
port = $ssh_port
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban >/dev/null 2>&1 || true
ok "Fail2ban blocks an address for an hour after 5 failed SSH logins"

# ---- Kernel network settings ----
cat > /etc/sysctl.d/60-odonut.conf <<'EOF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.log_martians = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
EOF
sysctl --system >/dev/null 2>&1 || true
ok "Network settings hardened"

# ---- The app's own files ----
[ -f .env ] && chmod 600 .env
mkdir -p secrets backups
# secrets/ itself stays readable so the app (which runs as an ordinary user) can read the wallet
# certificates; the Cloudflare key inside it is for the web server only.
chmod 755 secrets
[ -d secrets/cloudflare ] && chmod 700 secrets/cloudflare
chmod 700 backups
ok "Passwords file (.env), backups/ and the Cloudflare key readable by the server admin only"
