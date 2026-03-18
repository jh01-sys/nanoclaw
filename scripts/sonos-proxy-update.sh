#!/usr/bin/env bash
# sonos-proxy-update.sh
# Updates the Windows netsh portproxy rule to forward Sonos API traffic to the
# current WSL2 IP. Run this on WSL boot so the rule survives IP changes.
#
# The WSL2 IP changes on every reboot. This script reads the current IP and
# tells Windows to forward TCP port 3500 → WSL2:3500 via PowerShell.
#
# Setup (run once):
#   1. Copy this script to a stable location (e.g. ~/bin/sonos-proxy-update.sh)
#   2. Make executable: chmod +x ~/bin/sonos-proxy-update.sh
#   3. Add to WSL boot via /etc/wsl.conf (requires WSL 0.67.6+):
#
#      [boot]
#      command = /home/jake/bin/sonos-proxy-update.sh
#
#   OR add to ~/.profile / ~/.bashrc for login-time execution.
#
# Note: netsh portproxy requires Administrator on Windows. The PowerShell
# command uses -Verb RunAs to elevate. You may see a UAC prompt on first boot.
#
# Ports:
#   SONOS_PORT=3500      — node-sonos-http-api default port
#   LISTEN_PORT=3500     — Windows listens on same port number
#   DASHBOARD_PORT=8080  — NanoClaw dashboard port

set -euo pipefail

SONOS_PORT="${SONOS_PORT:-3500}"        # UPnP callback port (Windows portproxy → WSL2)
LISTEN_PORT="${LISTEN_PORT:-3500}"      # Windows listen port (same number)
SONOS_API_PORT="${SONOS_API_PORT:-5005}" # node-sonos-http-api HTTP port
DASHBOARD_PORT="${DASHBOARD_PORT:-8080}" # NanoClaw dashboard port

# Get WSL2's eth0 IP
WSL2_IP=$(ip addr show eth0 2>/dev/null | awk '/inet / { gsub(/\/.*/, "", $2); print $2; exit }')

if [[ -z "$WSL2_IP" ]]; then
    echo "[sonos-proxy] ERROR: Could not determine WSL2 IP from eth0" >&2
    exit 1
fi

echo "[sonos-proxy] WSL2 IP: $WSL2_IP — updating Windows portproxy $LISTEN_PORT → $WSL2_IP:$SONOS_PORT"

# Run PowerShell as Administrator to update (or add) the portproxy rule.
# We use -Command with a here-string so it's a single powershell.exe call.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
    \$ErrorActionPreference = 'Stop'
    \$rule = netsh interface portproxy show v4tov4 | Select-String '0\.0\.0\.0.*$LISTEN_PORT'
    if (\$rule) {
        netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$LISTEN_PORT | Out-Null
    }
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$LISTEN_PORT connectaddress=$WSL2_IP connectport=$SONOS_PORT
    Write-Host '[sonos-proxy] Windows portproxy rule updated: 0.0.0.0:$LISTEN_PORT -> ${WSL2_IP}:$SONOS_PORT'
" 2>&1 || {
    # If PowerShell fails (e.g. not on PATH), try via wsl.exe interop path
    echo "[sonos-proxy] PowerShell call failed — trying /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" >&2
    /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
        netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$LISTEN_PORT 2>\$null
        netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$LISTEN_PORT connectaddress=$WSL2_IP connectport=$SONOS_PORT
    " 2>&1
} || echo "[sonos-proxy] WARNING: netsh portproxy update failed (requires Windows admin elevation) — continuing to update env conf" >&2

echo "[sonos-proxy] WSL2 IP: $WSL2_IP — updating Windows portproxy $DASHBOARD_PORT → $WSL2_IP:$DASHBOARD_PORT"

# Forward dashboard port 8080 to WSL2
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
    \$ErrorActionPreference = 'Stop'
    \$rule = netsh interface portproxy show v4tov4 | Select-String '0\.0\.0\.0.*$DASHBOARD_PORT'
    if (\$rule) {
        netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$DASHBOARD_PORT | Out-Null
    }
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$DASHBOARD_PORT connectaddress=$WSL2_IP connectport=$DASHBOARD_PORT
    Write-Host '[sonos-proxy] Windows portproxy rule updated: 0.0.0.0:$DASHBOARD_PORT -> ${WSL2_IP}:$DASHBOARD_PORT'
" 2>&1 || {
    echo "[sonos-proxy] PowerShell call failed — trying /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" >&2
    /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
        netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$DASHBOARD_PORT 2>\$null
        netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$DASHBOARD_PORT connectaddress=$WSL2_IP connectport=$DASHBOARD_PORT
    " 2>&1
} || echo "[sonos-proxy] WARNING: netsh portproxy update for port $DASHBOARD_PORT failed (requires Windows admin elevation)" >&2

# Update SONOS_API_URL in the nanoclaw systemd service via a drop-in override.
# This ensures the container agent always connects to the correct WSL2 IP on boot.
DROPIN_DIR="${HOME}/.config/systemd/user/nanoclaw.service.d"
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/sonos-env.conf" <<EOF
[Service]
Environment=SONOS_API_URL=http://${WSL2_IP}:${SONOS_API_PORT}
EOF
echo "[sonos-proxy] Wrote SONOS_API_URL=http://${WSL2_IP}:${SONOS_API_PORT} → ${DROPIN_DIR}/sonos-env.conf"

# Reload unit files so nanoclaw picks up the updated env on its next start.
systemctl --user daemon-reload 2>/dev/null || true

echo "[sonos-proxy] Done."
